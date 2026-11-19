// Playback memory probe: plays every authored time code through
// `request_animated_pose` (the app's per-pose owner turn) for N loops and
// prints the process RSS after each loop, so "does playback grow loop after
// loop?" is answered with numbers.
//
// cargo run [--release] --example profile_memory_loops
//   USD_PATH=<asset>   asset under test (default CarbonFrameBike.usdz)
//   LOOPS=<n>          loop count (default 8)

use std::path::PathBuf;
use std::time::Instant;

use usdbee_lib::stage::{
    noop_sink, open_stage, request_animated_pose, request_set_warmup_enabled, request_time_codes,
    StageState,
};

fn rss_kib() -> u64 {
    let statm = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let pages: u64 = statm
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    pages * 4
}

fn extract(archive_path: &PathBuf) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("usdbee-memloops-{}", std::process::id()));
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
    let loops: usize = std::env::var("LOOPS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8);
    let is_usdz = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("usdz"));
    let (open_path, extraction) = if is_usdz {
        let (root, dir) = extract(&path);
        (root, Some(dir))
    } else {
        (path.clone(), None)
    };

    let state = StageState::new(noop_sink());
    let info = state
        .open(&open_path, is_usdz, None, extraction.as_deref())
        .unwrap();
    let sender = state.sender(info.stage_id).unwrap();
    request_set_warmup_enabled(&sender, false).unwrap();
    let mut codes = request_time_codes(&sender).unwrap();
    codes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    codes.dedup();
    // GRID=1 plays the tcps grid instead of the authored codes: the app asks
    // for those times inside a code hole, and they are keys the authored list
    // never contains, so they are what saturates the frame cache.
    if std::env::var("GRID").is_ok_and(|value| value != "0") {
        let step = 1.0 / info.time_codes_per_second;
        let (start, end) = (info.start_time_code, info.end_time_code);
        codes = Vec::new();
        let mut time = start;
        while time <= end + 1e-9 {
            codes.push(time);
            time += step;
        }
    }
    let _ = open_stage(&path).map(|(stage, _)| stage);

    println!(
        "ASSET {} codes {} rss {} KiB",
        path.display(),
        codes.len(),
        rss_kib()
    );
    for loop_index in 0..loops {
        let start = Instant::now();
        let before = rss_kib();
        let mut nodes = 0usize;
        for code in &codes {
            let frame = request_animated_pose(&sender, Some(*code)).unwrap();
            nodes += frame.len();
        }
        println!(
            "LOOP {} rss {} KiB (delta {} KiB, {} ms, {} bytes)",
            loop_index + 1,
            rss_kib(),
            rss_kib() as i64 - before as i64,
            start.elapsed().as_millis(),
            nodes
        );
    }
    if let Some(dir) = extraction {
        let _ = std::fs::remove_dir_all(dir);
    }
}
