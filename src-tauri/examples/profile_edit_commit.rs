// Gizmo-commit cost probe over the real stage-owner path: simulates the
// exact request sequence a viewport drag-release triggers (commit lock:
// details -> op writes -> tree -> details; then per-write event refreshes:
// the single-write path (commit B) against the batched request (commit C),
// which is what the gizmo commit sends: one transaction, one event, one
// cache clear.
// manifest + geometry prefetch + tree) and prints per-step wall times plus
// tessellation re-runs, so a "the app hangs after I release the gizmo"
// report can be attributed to a step instead of guessed at.
//
// cargo run --release --example profile_edit_commit
//   USD_PATH=<asset>   asset under test (default CarbonFrameBike.usdz)

use std::path::PathBuf;
use std::time::{Duration, Instant};

use usdbee_lib::stage::{
    noop_sink, request_geometry_data, request_scene_manifest, request_set_attribute_value,
    request_set_attribute_values, request_stage_details, request_stage_tree, AttributeWrite,
    StageState,
};
use usdbee_lib::values::{PrimDetails, ValuePayload};

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn step(label: &str, start: Instant, extra: &str) -> f64 {
    let elapsed = ms(start.elapsed());
    println!("STEP {:38} {:8.1} ms  {}", label, elapsed, extra);
    elapsed
}

fn attribute<'a>(
    details: &'a PrimDetails,
    name: &str,
) -> Option<&'a usdbee_lib::values::AttributeInfo> {
    details.attributes.iter().find(|attr| attr.name == name)
}

fn main() {
    let path = std::env::var_os("USD_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../assets/full_assets/CarbonFrameBike/CarbonFrameBike.usdz")
        });
    println!(
        "ASSET {} ({})",
        path.display(),
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );

    // The app opens a usdz through its extraction dir; reuse that shape.
    let mut open_path = path.clone();
    let mut extraction_dir: Option<PathBuf> = None;
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("usdz"))
    {
        let dir = std::env::temp_dir().join(format!("usdbee-edit-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(archive).unwrap();
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).unwrap();
            if entry.name().ends_with('/') {
                continue;
            }
            let out = dir.join(entry.name());
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            let mut file = std::fs::File::create(&out).unwrap();
            std::io::copy(&mut entry, &mut file).unwrap();
        }
        let mut best: Option<PathBuf> = None;
        for entry in walkdir::WalkDir::new(&dir).into_iter().flatten() {
            let candidate = entry.path().to_path_buf();
            let is_usd = candidate
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| {
                    value.eq_ignore_ascii_case("usdc") || value.eq_ignore_ascii_case("usda")
                });
            let shallower = best.as_ref().is_none_or(|current| {
                candidate.components().count() < current.components().count()
            });
            if is_usd && shallower {
                best = Some(candidate);
            }
        }
        open_path = best.expect("extracted archive should hold a USD root");
        extraction_dir = Some(dir);
    }

    let state = StageState::new(noop_sink());
    let info = state
        .open(
            &open_path,
            extraction_dir.is_some(),
            None,
            extraction_dir.as_deref(),
        )
        .unwrap();
    let sender = state.sender(info.stage_id).unwrap();
    // Reads sample the playback time; the gizmo authors at DEFAULT time
    // (`gizmoCommit.svelte.ts` passes `undefined` for op values), so the
    // writes below pass None.
    let time = Some(info.start_time_code);

    // Pick the first geometry prim from the manifest as the drag target.
    let manifest = request_scene_manifest(&sender, time).unwrap();
    fn first_geometry(
        nodes: &[usdbee_lib::stage::RenderNode],
    ) -> Option<&usdbee_lib::stage::RenderNode> {
        for node in nodes {
            if node.has_geometry {
                return Some(node);
            }
            if let Some(found) = first_geometry(&node.children) {
                return Some(found);
            }
        }
        None
    }
    let target = first_geometry(&manifest).expect("asset should hold a geometry prim");
    let target_path = target.path.clone();
    println!("TARGET {}", target_path);

    // Baseline warm-up: everything the app fetched before the first drag.
    let start = Instant::now();
    let _ = request_stage_tree(&sender).unwrap();
    step("baseline tree (builds the cache)", start, "");
    let start = Instant::now();
    let _ = request_scene_manifest(&sender, time).unwrap();
    step("baseline manifest (skeleton cached)", start, "");
    let start = Instant::now();
    request_geometry_data(&sender, &target_path, time).expect("geometry fetch");
    step("baseline geometry (tessellation)", start, "");
    let tessellations = state.mesh_tessellations(info.stage_id).unwrap();
    println!("CACHED tessellations so far: {}", tessellations);

    // --- Commit A: move (update an existing translate op = one write) ----
    let details = request_stage_details(&sender, &target_path, time).unwrap();
    let translate = attribute(&details, "xformOp:translate")
        .expect("the target should carry a translate op to update");
    let order: Vec<String> = attribute(&details, "xformOpOrder")
        .and_then(|attr| {
            attr.value.data.as_array().map(|values| {
                values
                    .iter()
                    .map(|v| v.as_str().unwrap_or_default().to_string())
                    .collect()
            })
        })
        .unwrap_or_default();
    let current: Vec<f64> = translate
        .value
        .data
        .as_array()
        .map(|values| values.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect())
        .unwrap_or_default();
    let moved: Vec<f64> = current.iter().map(|v| v + 1.5).collect();

    println!("\n-- commit A: move release (commit lock) --");
    let start = Instant::now();
    request_stage_details(&sender, &target_path, time).unwrap();
    let lock_details = step("lock: refreshSelectedDetails", start, "");
    let start = Instant::now();
    request_set_attribute_value(
        &sender,
        &target_path,
        "xformOp:translate",
        &ValuePayload {
            r#type: translate.value.r#type.clone(),
            data: serde_json::json!(moved),
            truncated: None,
            count: None,
        },
        None,
    )
    .expect("translate write");
    let lock_write = step("lock: write translate op", start, "");
    let start = Instant::now();
    let _ = request_stage_tree(&sender).unwrap();
    let lock_tree = step(
        "lock: refreshAfterEdit tree",
        start,
        "cache cleared by the write",
    );
    let start = Instant::now();
    request_stage_details(&sender, &target_path, time).unwrap();
    let lock_reselect = step("lock: reselect details", start, "");
    let lock_a = lock_details + lock_write + lock_tree + lock_reselect;
    println!("LOCK TOTAL {:.1} ms (gizmo stays disabled)", lock_a);

    println!("-- commit A: event-driven scene refresh (one write = one event) --");
    let start = Instant::now();
    let _ = request_scene_manifest(&sender, time).unwrap();
    let ev_manifest = step("event: manifest", start, "skeleton rebuilt");
    let start = Instant::now();
    request_geometry_data(&sender, &target_path, time).expect("geometry prefetch");
    let ev_geometry = step("event: geometry prefetch", start, "re-tessellated");
    let start = Instant::now();
    let _ = request_stage_tree(&sender).unwrap();
    let ev_tree = step("event: page tree refresh", start, "");
    let tess_a = state.mesh_tessellations(info.stage_id).unwrap() - tessellations;
    println!(
        "EVENT TOTAL {:.1} ms  (re-tessellations: {})",
        ev_manifest + ev_geometry + ev_tree,
        tess_a
    );

    // --- Commit B: rotate (author a new op = two writes = two events) ----
    println!("\n-- commit B: rotate release (commit lock, two writes) --");
    let start = Instant::now();
    request_stage_details(&sender, &target_path, time).unwrap();
    let mut lock_b = step("lock: refreshSelectedDetails", start, "");
    let start = Instant::now();
    request_set_attribute_value(
        &sender,
        &target_path,
        "xformOp:rotateXYZ",
        &ValuePayload {
            r#type: "float3".into(),
            data: serde_json::json!([0.0, 0.0, 90.0]),
            truncated: None,
            count: None,
        },
        None,
    )
    .expect("rotate write");
    lock_b += step("lock: write rotateXYZ op", start, "");
    let mut order_with_rotate = order.clone();
    if !order_with_rotate.contains(&"xformOp:rotateXYZ".to_string()) {
        order_with_rotate.push("xformOp:rotateXYZ".into());
    }
    let start = Instant::now();
    request_set_attribute_value(
        &sender,
        &target_path,
        "xformOpOrder",
        &ValuePayload {
            r#type: "token_array".into(),
            data: serde_json::json!(order_with_rotate),
            truncated: None,
            count: None,
        },
        None,
    )
    .expect("order write");
    lock_b += step("lock: write xformOpOrder", start, "");
    let start = Instant::now();
    let _ = request_stage_tree(&sender).unwrap();
    lock_b += step("lock: refreshAfterEdit tree", start, "cache cleared again");
    let start = Instant::now();
    request_stage_details(&sender, &target_path, time).unwrap();
    lock_b += step("lock: reselect details", start, "");
    println!("LOCK TOTAL {:.1} ms (gizmo stays disabled)", lock_b);

    println!("-- commit B: event refreshes (two events) --");
    let mut event_b = 0.0;
    for event in 1..=2 {
        let start = Instant::now();
        let _ = request_scene_manifest(&sender, time).unwrap();
        event_b += step(&format!("event {}: manifest", event), start, "");
        let start = Instant::now();
        request_geometry_data(&sender, &target_path, time).expect("geometry prefetch");
        event_b += step(&format!("event {}: geometry prefetch", event), start, "");
        let start = Instant::now();
        let _ = request_stage_tree(&sender).unwrap();
        event_b += step(&format!("event {}: page tree", event), start, "");
    }
    let tess_b = state.mesh_tessellations(info.stage_id).unwrap() - tessellations - tess_a;
    println!(
        "EVENT TOTAL {:.1} ms  (re-tessellations: {})",
        event_b, tess_b
    );

    // --- Commit C: the batched request (one transaction) ----------------
    println!("\n-- commit C: rotate release, batched (one write, one event) --");
    let start = Instant::now();
    request_stage_details(&sender, &target_path, time).unwrap();
    let mut lock_c = step("lock: refreshSelectedDetails", start, "");
    let start = Instant::now();
    request_set_attribute_values(
        &sender,
        &target_path,
        &[
            AttributeWrite {
                name: "xformOp:rotateXYZ".into(),
                value: ValuePayload {
                    r#type: "float3".into(),
                    data: serde_json::json!([0.0, 0.0, 45.0]),
                    truncated: None,
                    count: None,
                },
                time: None,
            },
            AttributeWrite {
                name: "xformOpOrder".into(),
                value: ValuePayload {
                    r#type: "token_array".into(),
                    data: serde_json::json!(order_with_rotate),
                    truncated: None,
                    count: None,
                },
                time: None,
            },
        ],
    )
    .expect("batched rotate write");
    lock_c += step("lock: write the whole batch", start, "");
    let start = Instant::now();
    let _ = request_stage_tree(&sender).unwrap();
    lock_c += step("lock: refreshAfterEdit tree", start, "cache cleared once");
    let start = Instant::now();
    request_stage_details(&sender, &target_path, time).unwrap();
    lock_c += step("lock: reselect details", start, "");
    println!("LOCK TOTAL {:.1} ms (gizmo stays disabled)", lock_c);

    println!("-- commit C: event refresh (one event) --");
    let start = Instant::now();
    let _ = request_scene_manifest(&sender, time).unwrap();
    let mut event_c = step("event: manifest", start, "");
    let start = Instant::now();
    request_geometry_data(&sender, &target_path, time).expect("geometry prefetch");
    event_c += step("event: geometry prefetch", start, "");
    let start = Instant::now();
    let _ = request_stage_tree(&sender).unwrap();
    event_c += step("event: page tree", start, "");
    let tess_c = state.mesh_tessellations(info.stage_id).unwrap() - tessellations - tess_a - tess_b;
    println!(
        "EVENT TOTAL {:.1} ms  (re-tessellations: {})",
        event_c, tess_c
    );

    println!(
        "\nSUMMARY move: lock {:.0} ms + events {:.0} ms | rotate (3 writes): lock {:.0} ms + events {:.0} ms | rotate (batched): lock {:.0} ms + events {:.0} ms | re-tessellations {}",
        lock_a,
        ev_manifest + ev_geometry + ev_tree,
        lock_b,
        event_b,
        lock_c,
        event_c,
        tess_a + tess_b + tess_c
    );
}
