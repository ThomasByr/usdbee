// Playback loop probe: plays every authored time code through the backend paths
// playback uses and reports the per-step cost of each loop, so "is playback warm
// after one pass?" can be answered with numbers instead of assumed from cache
// sizes.
//
// Rows, per loop:
//   walk      `GetAnimatedManifest` alone: the delta walk, no JSON encode and
//             no geometry. The difference against `pose` is the encode.
//   geometry  `GetGeometryBatch` over every `has_geometry` delta node (14 prims
//             on the bike). This is NOT what the app fetches: the app only
//             batches `geometry_animated` (1 prim) inside `get_animated_pose`.
//             Kept because it is what drives the cold tessellation count.
//   pose      `GetAnimatedPose`: the owner turn the app's single invoke pays,
//             i.e. walk + `serde_json::to_vec` of the delta + the app's
//             `geometry_animated` paths + one batch + `frame_pose`'s copies.
//             This is the per-pose backend cost the app actually sees.
//   step avg  same as the pose avg (kept for continuity with the published
//             tables): the app's per-pose backend cost and its fps
//             ceiling (the frontend decode and GPU upload are not measured).
//   tessell.  MeshCache insert count for the stage: 3,934 after loop 1 and
//             unchanged after, since a warm pose must tessellate nothing.
//
// The pose row runs after the two rows above, so every loop's `pose` is warm:
// loop 1's cold tessellation is charged to `geometry`. Every pose
// frame is sanity-parsed (JSON decodes, path list matches the batch slots) so a
// corrupted payload cannot pass as a fast one.
//
// cargo run [--release] --example profile_playback_loops
//   USD_PATH=<asset>   asset under test (default CarbonFrameBike.usdz)

use std::path::PathBuf;
use std::time::{Duration, Instant};

use usdbee_lib::stage::{
    noop_sink, open_stage, request_animated_manifest, request_animated_pose,
    request_geometry_batch, request_time_codes, RenderNode, StageState,
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

fn take<'a>(bytes: &'a [u8], at: &mut usize, len: usize) -> Result<&'a [u8], String> {
    let end = at
        .checked_add(len)
        .ok_or_else(|| "frame length overflow".to_string())?;
    let slice = bytes
        .get(*at..end)
        .ok_or_else(|| format!("frame truncated at {} + {}", at, len))?;
    *at = end;
    Ok(slice)
}

fn take_u32(bytes: &[u8], at: &mut usize) -> Result<u32, String> {
    let slice = take(bytes, at, 4)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Parse the merged pose frame far enough to prove it is intact:
/// `[u32 path count][paths][pad][u32 node count][node records][batch]`. Every
/// path must be UTF-8 and dense, every node's path id must resolve, every
/// first child id must stay inside the node array, and the batch tail must
/// hold exactly one slot per deforming, deduped node path with nothing left
/// over.
fn check_pose_frame(bytes: &[u8]) -> Result<usize, String> {
    let mut at = 0;
    let path_count = take_u32(bytes, &mut at)? as usize;
    let mut paths: Vec<&str> = Vec::with_capacity(path_count);
    for _ in 0..path_count {
        let len = take_u32(bytes, &mut at)? as usize;
        let path = take(bytes, &mut at, len)?;
        paths.push(std::str::from_utf8(path).map_err(|error| format!("pose path: {}", error))?);
    }
    at = (at + 3) & !3;
    let node_count = take_u32(bytes, &mut at)? as usize;
    let mut slots_expected = 0usize;
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for index in 0..node_count {
        let path_id = take_u32(bytes, &mut at)? as usize;
        let first_child = take_u32(bytes, &mut at)?;
        let child_count = {
            let slice = take(bytes, &mut at, 2)?;
            u16::from_le_bytes([slice[0], slice[1]]) as usize
        };
        let header = take(bytes, &mut at, 2)?;
        let (flags, visible) = (header[0], header[1]);
        if visible > 1 {
            return Err(format!("pose frame: node {} visibility {}", index, visible));
        }
        if child_count == 0 {
            if first_child != u32::MAX {
                return Err(format!(
                    "pose frame: leaf {} points at {}",
                    index, first_child
                ));
            }
        } else if first_child as usize != index + 1 {
            return Err(format!(
                "pose frame: node {} first child {} is not the next index",
                index, first_child
            ));
        }
        let path = paths
            .get(path_id)
            .ok_or_else(|| format!("pose frame: node {} path id {}", index, path_id))?;
        if flags & 0b110 == 0b110 && seen.insert(path) {
            slots_expected += 1;
        }
        take(bytes, &mut at, 64)?; // 16 x f32 matrix
        if flags & 0b100 != 0 {
            let instances = take_u32(bytes, &mut at)? as usize;
            take(bytes, &mut at, instances * 64)?;
        }
    }
    let magic = take_u32(bytes, &mut at)?;
    if magic != 0x5553_4247 {
        return Err(format!("pose frame: bad batch magic {:#x}", magic));
    }
    take_u32(bytes, &mut at)?; // batch version
    let slots = take_u32(bytes, &mut at)? as usize;
    if slots != slots_expected {
        return Err(format!(
            "pose frame: {} deforming paths, {} batch slots",
            slots_expected, slots
        ));
    }
    for _ in 0..slots {
        let status = take_u32(bytes, &mut at)?;
        if status != 0 {
            return Err(format!("pose frame: slot status {}", status));
        }
        let len = take_u32(bytes, &mut at)? as usize;
        take(bytes, &mut at, len)?;
        at = (at + 3) & !3;
    }
    if at != bytes.len() {
        return Err(format!("pose frame: {} trailing bytes", bytes.len() - at));
    }
    Ok(node_count)
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

    let mut frames_checked = 0usize;
    for (loops_done, label) in ["loop 1", "loop 2", "loop 3"].iter().enumerate() {
        let mut walk_total = 0.0;
        let mut geo_total = 0.0;
        let mut pose_total = 0.0;
        let mut nodes_total = 0usize;
        let mut prims_total = 0usize;
        let mut pose_prims_total = 0usize;
        let mut walk_max: f64 = 0.0;
        let mut geo_max: f64 = 0.0;
        let mut pose_max: f64 = 0.0;
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
            let start = Instant::now();
            let frame = request_animated_pose(&sender, Some(time)).unwrap();
            let pose_ms = ms(start.elapsed());
            pose_total += pose_ms;
            pose_max = pose_max.max(pose_ms);
            match check_pose_frame(&frame) {
                Ok(paths) => {
                    pose_prims_total += paths;
                    frames_checked += 1;
                }
                Err(error) => {
                    eprintln!("PROBE ERROR time {}: {}", time, error);
                    std::process::exit(1);
                }
            }
        }
        let steps = codes.len() as f64;
        let pose_avg = pose_total / steps;
        println!(
            "LOOP {} ({}) walk avg {:.2} ms max {:.2} | geometry has_geometry {:.1} prims avg {:.2} ms max {:.2} | pose app turn {:.1} prims avg {:.2} ms max {:.2} | {:.1} nodes | step avg {:.2} ms -> {:.1} fps | tessellations {}",
            loops_done + 1,
            label,
            walk_total / steps,
            walk_max,
            prims_total as f64 / steps,
            geo_total / steps,
            geo_max,
            pose_prims_total as f64 / steps,
            pose_avg,
            pose_max,
            nodes_total as f64 / steps,
            pose_avg,
            1000.0 / pose_avg.max(0.001),
            state.mesh_tessellations(info.stage_id).unwrap_or(0)
        );
    }
    println!(
        "FRAMES {} pose frames parsed (json decoded, path list == batch slots)",
        frames_checked
    );
    if let Some(dir) = extraction {
        let _ = std::fs::remove_dir_all(dir);
    }
}
