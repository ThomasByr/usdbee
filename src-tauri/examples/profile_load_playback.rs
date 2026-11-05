// Load and playback cost probe over the real stage-owner path (same actor,
// cached manifest skeleton and tessellation cache the app uses).
//
// cargo run --release --example profile_load_playback
//   USD_PATH=<asset>   asset under test (default CarbonFrameBike.usdz)
//   SWEEP_STEPS=<n>    playback samples across the authored span (default 48)
//   DUMP_DIR=<dir>     also write the exact frontend payloads (manifest, geometry
//                      batches, materials, per-step deltas) for a JS-side harness
//
// Prints per-phase wall times plus the JSON/IPC payload sizes each phase
// produces, so a "long load" or "stuttery playback" report can be attributed
// to a phase instead of guessed at.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use openusd::sdf;
use openusd::usd::{Prim, TimeCode};
use openusd_schemas::geom::{Imageable, ImageableExt};
use usdbee_lib::values::local_transform;

use usdbee_lib::stage::{
    noop_sink, open_stage, request_animated_manifest, request_geometry_batch,
    request_geometry_data, request_material_data, request_scene_manifest, request_stage_details,
    request_stage_tree, request_time_codes, PrimNode, RenderNode, StageState,
};

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn count_tree(nodes: &[PrimNode]) -> usize {
    nodes
        .iter()
        .map(|node| 1 + count_tree(&node.children))
        .sum()
}

fn walk<'a>(nodes: &'a [RenderNode], out: &mut Vec<&'a RenderNode>) {
    for node in nodes {
        out.push(node);
        walk(&node.children, out);
    }
}

/// The frontend payloads a JS harness needs to replay load and playback
/// against the real builders.
struct Dump {
    dir: PathBuf,
}

impl Dump {
    fn new() -> Option<Dump> {
        let dir = std::env::var_os("DUMP_DIR").map(PathBuf::from)?;
        std::fs::create_dir_all(dir.join("steps")).ok()?;
        Some(Dump { dir })
    }

    fn write(&self, name: &str, bytes: &[u8]) {
        std::fs::write(self.dir.join(name), bytes).unwrap();
    }

    fn json<T: serde::Serialize>(&self, name: &str, value: &T) {
        self.write(name, &serde_json::to_vec(value).unwrap());
    }
}

fn main() {
    let path = std::env::var_os("USD_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../assets/full_assets/CarbonFrameBike/CarbonFrameBike.usdz")
        });
    let sweep = std::env::var("SWEEP_STEPS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(48);
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    println!("ASSET {} ({})", path.display(), profile);
    let dump = Dump::new();

    // The authored span comes from a direct open; the actor path below is
    // what the timings measure.
    let (_, span_info) = open_stage(&path).unwrap();
    let is_usdz = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("usdz"));

    // Mirror the app's open: a usdz is extracted to a cache dir first and the
    // extracted root is what gets scanned and opened.
    let mut open_path = path.clone();
    let mut extraction_dir: Option<PathBuf> = None;
    if is_usdz {
        let start = Instant::now();
        let dir = std::env::temp_dir().join(format!("usdbee-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(archive).unwrap();
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).unwrap();
            let name = entry.name().to_string();
            if name.ends_with('/') {
                continue;
            }
            let out = dir.join(&name);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            let mut file = std::fs::File::create(&out).unwrap();
            std::io::copy(&mut entry, &mut file).unwrap();
        }
        println!("PHASE usdz_extract {:.1} ms", ms(start.elapsed()));
        open_path = dir.join(path.file_stem().unwrap()).with_extension("usdc");
        if !open_path.exists() {
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
        }
        extraction_dir = Some(dir);
    }

    let state = StageState::new(noop_sink());
    let start = Instant::now();
    let info = state
        .open(&open_path, is_usdz, None, extraction_dir.as_deref())
        .unwrap();
    println!(
        "PHASE open {:.1} ms  tcps={} start={} end={}",
        ms(start.elapsed()),
        info.time_codes_per_second,
        info.start_time_code,
        info.end_time_code
    );

    // The app's dependency scan: against the stage the open just parsed.
    let start = Instant::now();
    let scan = state.get_dependencies(info.stage_id).unwrap();
    println!(
        "PHASE dep_scan {:.1} ms  {} dependencies",
        ms(start.elapsed()),
        scan.entries.len()
    );
    let sender = state.sender(info.stage_id).unwrap();

    let start = Instant::now();
    let tree = request_stage_tree(&sender).unwrap();
    println!(
        "PHASE tree {:.1} ms  {} prims",
        ms(start.elapsed()),
        count_tree(&tree)
    );

    let time = info.start_time_code;
    let start = Instant::now();
    let manifest = request_scene_manifest(&sender, Some(time)).unwrap();
    let first_ms = ms(start.elapsed());
    let json = serde_json::to_vec(&manifest).unwrap();
    let mut nodes = Vec::new();
    walk(&manifest, &mut nodes);
    println!(
        "PHASE full_manifest_first {:.1} ms  {} nodes  {:.1} KiB json (manifest skeleton build included)",
        first_ms,
        nodes.len(),
        json.len() as f64 / 1024.0
    );
    let start = Instant::now();
    let _ = request_scene_manifest(&sender, Some(time)).unwrap();
    println!(
        "PHASE full_manifest_warm {:.1} ms  (skeleton cached; the app's edit-refresh cost)",
        ms(start.elapsed())
    );

    let geometry_paths: Vec<String> = nodes
        .iter()
        .filter(|node| node.has_geometry)
        .map(|node| node.path.clone())
        .collect();
    let start = Instant::now();
    let packed = request_geometry_batch(&sender, &geometry_paths, Some(time)).unwrap();
    if let Some(dump) = &dump {
        dump.json("manifest.json", &manifest);
        dump.write("geometry_all.bin", &packed);
        dump.json("codes.json", &request_time_codes(&sender).unwrap());
        dump.write(
            "span.json",
            format!(
                "{{ \"start\": {}, \"end\": {}, \"tcps\": {} }}",
                info.start_time_code, info.end_time_code, info.time_codes_per_second
            )
            .as_bytes(),
        );
        let mut materials = serde_json::Map::new();
        for path in &geometry_paths {
            let info = request_material_data(&sender, path).unwrap();
            materials.insert(path.clone(), serde_json::to_value(&info).unwrap());
        }
        dump.json("materials.json", &materials);
    }
    println!(
        "PHASE load_geometry_cold {:.1} ms  {} prims  {:.2} MiB packed",
        ms(start.elapsed()),
        geometry_paths.len(),
        packed.len() as f64 / (1024.0 * 1024.0)
    );
    let start = Instant::now();
    let _ = request_geometry_batch(&sender, &geometry_paths, Some(time)).unwrap();
    println!(
        "PHASE load_geometry_warm {:.1} ms  (mesh cache hit)",
        ms(start.elapsed())
    );
    // The frontend builder awaits one get_material_data invoke per geometry
    // prim, sequentially: this is that loop's backend cost.
    let start = Instant::now();
    let mut material_bytes = 0usize;
    for path in &geometry_paths {
        material_bytes += serde_json::to_vec(&request_material_data(&sender, path).unwrap())
            .unwrap()
            .len();
    }
    println!(
        "PHASE load_materials {:.1} ms  {} sequential lookups  {:.1} KiB json",
        ms(start.elapsed()),
        geometry_paths.len(),
        material_bytes as f64 / 1024.0
    );
    println!(
        "PHASE tessellations {} (owner counter)",
        state.mesh_tessellations(info.stage_id).unwrap()
    );

    // Inspector selection cost: one full details read per selection. Timed
    // twice per prim so a first-touch composition cost is separable from the
    // steady per-call cost.
    let sample: Vec<&String> = nodes.iter().map(|node| &node.path).step_by(84).collect();
    let mut first_total = 0.0;
    let mut second_total = 0.0;
    for path in &sample {
        let start = Instant::now();
        let _ = request_stage_details(&sender, path, Some(time)).unwrap();
        let first = ms(start.elapsed());
        let start = Instant::now();
        let _ = request_stage_details(&sender, path, Some(time)).unwrap();
        let second = ms(start.elapsed());
        first_total += first;
        second_total += second;
        println!(
            "  details first {:.1} ms second {:.1} ms  {}",
            first, second, path
        );
    }
    println!(
        "PHASE details first {:.1} ms second {:.1} ms per selection ({} sampled)",
        first_total / sample.len() as f64,
        second_total / sample.len() as f64,
        sample.len()
    );

    // What the IPC layer pays to encode one full manifest as JSON.
    let start = Instant::now();
    for _ in 0..10 {
        let _ = serde_json::to_vec(&manifest).unwrap();
    }
    println!(
        "PHASE manifest_json_encode {:.2} ms per call",
        ms(start.elapsed()) / 10.0
    );

    let span = info.end_time_code - info.start_time_code;
    if span_info.end_time_code <= span_info.start_time_code && (span <= 0.0 || sweep == 0) {
        println!("PLAYBACK skipped (no authored animation span)");
        return;
    }
    let mut walk_total = 0.0;
    let mut walk_max: f64 = 0.0;
    let mut json_total = 0.0;
    let mut json_encode_total = 0.0;
    let mut json_max: f64 = 0.0;
    let mut nodes_total = 0usize;
    let mut geo_total = 0.0;
    let mut geo_max: f64 = 0.0;
    // What the app pays today: one get_geometry_data invoke per animated
    // prim (renderState.updateNodes), serialized.
    let mut per_path_total = 0.0;
    let mut batch_total = 0.0;
    let mut geo_bytes_total = 0usize;
    let mut prims_total = 0usize;
    for step in 0..sweep {
        let time = info.start_time_code + span * step as f64 / (sweep - 1) as f64;
        let start = Instant::now();
        let delta = request_animated_manifest(&sender, Some(time)).unwrap();
        let walk_elapsed = ms(start.elapsed());
        walk_total += walk_elapsed;
        walk_max = walk_max.max(walk_elapsed);
        let start_encode = Instant::now();
        let encoded = serde_json::to_vec(&delta).unwrap();
        json_encode_total += ms(start_encode.elapsed());
        json_total += encoded.len() as f64;
        json_max = json_max.max(encoded.len() as f64);
        let mut delta_nodes = Vec::new();
        walk(&delta, &mut delta_nodes);
        nodes_total += delta_nodes.len();
        let delta_paths: Vec<String> = delta_nodes
            .iter()
            .filter(|node| node.has_geometry)
            .map(|node| node.path.clone())
            .collect();
        prims_total += delta_paths.len();
        // Cold cost lands on whichever call runs first for this time: the
        // per-path loop (the app's playback path) does the tessellation, the
        // batch behind it only frames bytes.
        let start = Instant::now();
        for path in &delta_paths {
            let _ = request_geometry_data(&sender, path, Some(time)).unwrap();
        }
        let elapsed = ms(start.elapsed());
        per_path_total += elapsed;
        geo_total += elapsed;
        geo_max = geo_max.max(elapsed);
        let start = Instant::now();
        let bytes = request_geometry_batch(&sender, &delta_paths, Some(time)).unwrap();
        if let Some(dump) = &dump {
            dump.json(&format!("steps/step_{step}.json"), &delta);
            dump.write(&format!("steps/step_{step}.bin"), &bytes);
        }
        geo_bytes_total += bytes.len();
        batch_total += ms(start.elapsed());
    }
    let steps = sweep as f64;
    let per_step = (walk_total + geo_total) / steps;
    println!(
        "PLAYBACK delta_walk avg {:.2} ms max {:.2} ms (json encode {:.2} ms) | {:.1} nodes, {:.1} KiB json avg / {:.1} KiB max",
        walk_total / steps,
        walk_max,
        json_encode_total / steps,
        nodes_total as f64 / steps,
        json_total / steps / 1024.0,
        json_max / 1024.0
    );
    println!(
        "PLAYBACK geometry avg {:.2} ms max {:.2} ms | {:.1} prims, {:.2} MiB packed avg",
        geo_total / steps,
        geo_max,
        prims_total as f64 / steps,
        geo_bytes_total as f64 / steps / (1024.0 * 1024.0)
    );
    println!(
        "PLAYBACK geometry cold per-prim (app path, does the tessellation) avg {:.2} ms; warm batch refetch avg {:.2} ms",
        per_path_total / steps,
        batch_total / steps
    );
    println!(
        "PLAYBACK backend per step avg {:.2} ms -> {:.1} fps ceiling (before IPC, JSON parse, GPU upload)",
        per_step,
        1000.0 / per_step.max(0.001)
    );

    // Per-node read costs the delta walk pays, split by operation. A second
    // direct open is used because the actor's stage never leaves its thread.
    let (bench_stage, _) = open_stage(&open_path).unwrap();
    let mut animated_paths: Vec<String> = Vec::new();
    let first_delta = request_animated_manifest(&sender, Some(time)).unwrap();
    let mut delta_nodes = Vec::new();
    walk(&first_delta, &mut delta_nodes);
    for node in &delta_nodes {
        animated_paths.push(node.path.clone());
    }
    let prims: Vec<Prim> = animated_paths
        .iter()
        .filter_map(|path| bench_stage.prim(sdf::try_into_path(path).unwrap()).ok())
        .filter(|prim| prim.is_valid().unwrap_or(false))
        .collect();
    let count = prims.len().max(1) as f64;

    let start = Instant::now();
    for prim in &prims {
        let _ = local_transform(prim, Some(time)).unwrap();
    }
    println!(
        "READ local_transform {:.3} ms/prim ({} prims)",
        ms(start.elapsed()) / count,
        prims.len()
    );

    let start = Instant::now();
    for prim in &prims {
        if let Ok(Some(imageable)) = Imageable::from_prim(prim.clone()) {
            let _ = imageable
                .compute_visibility(Some(TimeCode::new(time)))
                .unwrap();
        }
    }
    println!(
        "READ compute_visibility {:.3} ms/prim",
        ms(start.elapsed()) / count
    );

    let start = Instant::now();
    for prim in &prims {
        let _ = prim.type_name().unwrap();
    }
    println!("READ type_name {:.3} ms/prim", ms(start.elapsed()) / count);

    let start = Instant::now();
    for prim in &prims {
        let _ = prim.is_valid().unwrap();
    }
    println!("READ is_valid {:.3} ms/prim", ms(start.elapsed()) / count);

    let start = Instant::now();
    for prim in &prims {
        let _ = bench_stage.prim(prim.path()).unwrap();
    }
    println!(
        "READ stage.prim(path) {:.3} ms/prim",
        ms(start.elapsed()) / count
    );

    // Where a 200 ms selection actually goes: composed reads per attribute.
    let deepest = prims
        .iter()
        .max_by_key(|prim| prim.path().to_string().len())
        .cloned();
    if let Some(prim) = deepest {
        let start = Instant::now();
        let attributes = prim.attributes().unwrap();
        let list_ms = ms(start.elapsed());
        let start = Instant::now();
        for attribute in &attributes {
            let _ = attribute
                .value_at::<sdf::Value>(Some(TimeCode::new(time)))
                .unwrap();
        }
        let value_ms = ms(start.elapsed());
        let start = Instant::now();
        for attribute in &attributes {
            let _ = attribute.has_authored_value().unwrap();
        }
        let authored_ms = ms(start.elapsed());
        let start = Instant::now();
        for attribute in &attributes {
            let _ = attribute.variability().unwrap();
        }
        let variability_ms = ms(start.elapsed());
        println!(
            "DETAILS {} attrs={} attributes()={:.2}ms value_at(sum)={:.2}ms has_authored(sum)={:.2}ms variability(sum)={:.2}ms",
            prim.path(),
            attributes.len(),
            list_ms,
            value_ms,
            authored_ms,
            variability_ms
        );
    }

    // Root layer reopen cost: what a prim-stack layer read pays per call.
    let stack = bench_stage.layer_stack();
    let start = Instant::now();
    let reopened = sdf::Layer::open(&stack[0]);
    println!(
        "READ sdf::Layer::open(root) {:.1} ms (ok={})",
        ms(start.elapsed()),
        reopened.is_ok()
    );

    // Prim-stack layer identifiers vs the stage's own layer stack: a cache
    // miss here means every prim-details read re-reads the layer file.
    if let Some(prim) = prims.first() {
        let sites = prim.prim_stack().unwrap();
        for site in &sites {
            let start = Instant::now();
            let opened = sdf::Layer::open(&site.layer);
            println!(
                "READ site.layer open {:.1} ms  id={}  (stage stack[0]={})",
                ms(start.elapsed()),
                site.layer,
                stack.first().cloned().unwrap_or_default()
            );
            let start = Instant::now();
            if let Ok(layer) = opened {
                let _ = layer.data().try_field(&site.path, "variantSetChildren");
            }
            println!("READ site try_field {:.1} ms", ms(start.elapsed()));
        }
    }
}
