// Playback loop probe: plays every authored time code twice and reports the
// per-step backend cost of each loop, so "is playback warm after one pass?"
// can be answered with numbers instead of assumed from cache sizes.
//
// cargo run [--release] --example profile_playback_loops
//   USD_PATH=<asset>   asset under test (default CarbonFrameBike.usdz)

use std::path::PathBuf;
use std::time::{Duration, Instant};

use usdbee_lib::stage::{
    noop_sink, open_stage, request_animated_manifest, request_geometry_batch, request_time_codes,
    RenderNode, StageState,
};

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn walk<'a>(nodes: &'a [RenderNode], out: &mut Vec<&'a RenderNode>) {
    for node in nodes {
        out.push(node);
        walk(&node.children, out);
    }
}

fn extract(archive_path: &PathBuf) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("usdbee-loops-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let archive = std::fs::File::open(archive_path).unwrap();
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
        let shallower = best
            .as_ref()
            .is_none_or(|current| candidate.components().count() < current.components().count());
        if is_usd && shallower {
            best = Some(candidate);
        }
    }
    (best.expect("no USD root in archive"), dir)
}

fn main() {
    let path = std::env::var_os("USD_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../assets/full_assets/CarbonFrameBike/CarbonFrameBike.usdz")
        });
    let is_usdz = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("usdz"));
    let (mut open_path, mut extraction) = (path.clone(), None);
    if is_usdz {
        let (root, dir) = extract(&path);
        open_path = root;
        extraction = Some(dir);
    }
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    println!("ASSET {} ({})", path.display(), profile);

    let state = StageState::new(noop_sink());
    let info = state
        .open(&open_path, is_usdz, None, extraction.as_deref())
        .unwrap();
    let sender = state.sender(info.stage_id).unwrap();
    let mut codes = request_time_codes(&sender).unwrap();
    codes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    codes.dedup();
    println!(
        "CODES {} authored  start={} end={} tcps={}",
        codes.len(),
        info.start_time_code,
        info.end_time_code,
        info.time_codes_per_second
    );

    // A load walks the manifest once under the app's usual flow; the skeleton
    // build that this triggers is not part of the playback cost.
    let _ = open_stage(&path).map(|(stage, _)| stage);

    for (loops_done, label) in ["loop 1", "loop 2", "loop 3"].iter().enumerate() {
        let mut walk_total = 0.0;
        let mut geo_total = 0.0;
        let mut nodes_total = 0usize;
        let mut prims_total = 0usize;
        let mut walk_max: f64 = 0.0;
        let mut geo_max: f64 = 0.0;
        for code in &codes {
            let time = *code;
            let start = Instant::now();
            let delta = request_animated_manifest(&sender, Some(time)).unwrap();
            let walk_ms = ms(start.elapsed());
            walk_total += walk_ms;
            walk_max = walk_max.max(walk_ms);
            let mut nodes = Vec::new();
            walk(&delta, &mut nodes);
            nodes_total += nodes.len();
            let paths: Vec<String> = nodes
                .iter()
                .filter(|node| node.has_geometry)
                .map(|node| node.path.clone())
                .collect();
            prims_total += paths.len();
            let start = Instant::now();
            let _ = request_geometry_batch(&sender, &paths, Some(time)).unwrap();
            let geo_ms = ms(start.elapsed());
            geo_total += geo_ms;
            geo_max = geo_max.max(geo_ms);
        }
        let steps = codes.len() as f64;
        println!(
            "LOOP {} ({}) walk avg {:.2} ms max {:.2} | geometry avg {:.2} ms max {:.2} | {:.1} nodes {:.1} prims | step avg {:.2} ms -> {:.1} fps | tessellations {}",
            loops_done + 1,
            label,
            walk_total / steps,
            walk_max,
            geo_total / steps,
            geo_max,
            nodes_total as f64 / steps,
            prims_total as f64 / steps,
            (walk_total + geo_total) / steps,
            1000.0 / ((walk_total + geo_total) / steps).max(0.001),
            state.mesh_tessellations(info.stage_id).unwrap_or(0)
        );
    }
    if let Some(dir) = extraction {
        let _ = std::fs::remove_dir_all(dir);
    }
}
