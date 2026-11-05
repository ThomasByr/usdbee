use crate::fetcher::get_usdbee_cache_dir;
use crate::models::{ProgressEvent, UsdDependencyNode, UsdSceneData};
use crate::parser::{resolve_remote_dependencies, DependencyScan};
use crate::stage::StageInfo;

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// The readable refusal a second open receives while one runs. It is not a
/// load failure: it reaches the frontend through the usd-load-refused
/// event (plus the command's Err for path opens), never usd-load-error —
/// a load-error would trip the first open's failure restoration.
pub const OPEN_IN_FLIGHT_MESSAGE: &str =
    "A USD file is already opening. Wait for it to finish before opening another.";

/// The dialog flow's failure channel: gate refusals are filtered out because
/// usd-load-refused already carried the notice.
pub(crate) fn dialog_load_error(err: &str) -> Option<String> {
    if err == OPEN_IN_FLIGHT_MESSAGE {
        None
    } else {
        Some(err.to_string())
    }
}

/// Serializes opens at the source: the native menu's dialog cannot be
/// intercepted from JS, so the backend refuses a second load while one is
/// running. The frontend's own slot spans tab adoption, so the JS listener
/// still guards the gap after this gate releases.
#[derive(Default)]
pub struct LoadGate {
    claimed: std::sync::atomic::AtomicBool,
}

impl LoadGate {
    pub fn claim(&self) -> Option<GateClaim<'_>> {
        if self
            .claimed
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
        {
            Some(GateClaim(self))
        } else {
            None
        }
    }
}

/// Released on drop (also on panic), so the gate can never leak.
pub struct GateClaim<'a>(&'a LoadGate);

impl Drop for GateClaim<'_> {
    fn drop(&mut self) {
        self.0
            .claimed
            .store(false, std::sync::atomic::Ordering::Release);
    }
}

#[tauri::command]
pub async fn trigger_open_usd_dialog(app: tauri::AppHandle) -> Result<(), String> {
    app.dialog()
        .file()
        .add_filter("USD Files", &["usd", "usda", "usdc", "usdz"])
        .pick_file(move |file_path| {
            if let Some(path) = file_path {
                let path_str = path.to_string();
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = process_usd_file(app_clone.clone(), path_str).await {
                        if let Some(e) = dialog_load_error(&e) {
                            eprintln!("Error loading USD: {}", e);
                            let _ = app_clone.emit("usd-load-error", e);
                        }
                    }
                });
            }
        });
    Ok(())
}

pub(crate) fn sanitize_entry_name(entry: &str, out_dir: &Path) -> Option<std::path::PathBuf> {
    // Zip entry names may use windows-style separators; normalize first so
    // drive letters and UNC prefixes are caught on every platform.
    let normalized = entry.replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return None;
    }
    for component in path.components() {
        match component {
            std::path::Component::Normal(c) => {
                // Windows drive letter like "C:" or drive-relative "C:evil.txt"
                let bytes = c.as_encoded_bytes();
                if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
                    return None;
                }
            }
            std::path::Component::CurDir => {}
            _ => return None, // ParentDir, RootDir, Prefix
        }
    }
    let mut out_path = out_dir.to_path_buf();
    for component in path.components() {
        if let std::path::Component::Normal(c) = component {
            out_path.push(c);
        }
    }
    Some(out_path)
}

fn extract_archive<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    out_dir: &Path,
) -> Result<String, String> {
    let result = extract_archive_inner(archive, out_dir);
    if result.is_err() {
        // Rejected or corrupt archives must not leave partially extracted
        // content behind; cleanup is best-effort and the original error wins.
        let _ = fs::remove_dir_all(out_dir);
    }
    result
}

fn extract_archive_inner<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    out_dir: &Path,
) -> Result<String, String> {
    fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let mut root_file: Option<String> = None;
    let mut first_file: Option<String> = None;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read archive entry {}: {}", i, e))?;
        let name = file.name().to_string();
        let outpath = sanitize_entry_name(&name, out_dir)
            .ok_or_else(|| format!("Refusing unsafe archive entry: {}", name))?;

        if file.is_dir() {
            fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;

        let abs_str = outpath
            .to_string_lossy()
            .replace("\\\\?\\", "")
            .replace("//?/", "");
        if first_file.is_none() {
            first_file = Some(abs_str.clone());
        }
        if root_file.is_none()
            && (name.ends_with(".usdc") || name.ends_with(".usda") || name.ends_with(".usd"))
        {
            root_file = Some(abs_str);
        }
    }

    root_file
        .or(first_file)
        .ok_or_else(|| "Empty USDZ archive".into())
}

async fn unpack_usdz(path: &str) -> Result<(String, std::path::PathBuf), String> {
    let p_str = path.to_string();
    let res = tauri::async_runtime::spawn_blocking(
        move || -> Result<(String, std::path::PathBuf), String> {
            let p = Path::new(&p_str);
            let file = fs::File::open(p).map_err(|e| e.to_string())?;

            let mut hasher = DefaultHasher::new();
            p_str.hash(&mut hasher);
            let hash = hasher.finish();

            let mut out_dir = get_usdbee_cache_dir();
            out_dir.push("extracted");
            out_dir.push(format!("{:016x}", hash));

            if out_dir.exists() {
                let _ = fs::remove_dir_all(&out_dir);
            }

            let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
            extract_archive(&mut archive, &out_dir).map(|root| (root, out_dir))
        },
    )
    .await;

    match res {
        Ok(Ok(res)) => Ok(res),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(e.to_string()),
    }
}

// The shared open orchestration for the dialog flow and the path-based
// command: emits the full usd-load-* event stream (start/progress/scene-
// loaded/stage-opened) and returns the opened stage's info. Refused while
// another load runs; the readable refusal reaches the frontend through
// the usd-load-refused event (and the command's Err for path opens).
async fn process_usd_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<StageInfo, String> {
    let gate = app.state::<LoadGate>();
    let Some(_claim) = gate.claim() else {
        let _ = app.emit("usd-load-refused", OPEN_IN_FLIGHT_MESSAGE);
        return Err(OPEN_IN_FLIGHT_MESSAGE.to_string());
    };
    process_usd_file_inner(&app, path).await
}

async fn process_usd_file_inner<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    mut path: String,
) -> Result<StageInfo, String> {
    app.emit("usd-load-start", path.clone())
        .unwrap_or_else(|e| eprintln!("Failed to emit usd-load-start: {}", e));

    app.emit(
        "usd-load-progress",
        ProgressEvent {
            stage: "Opening File".into(),
            percent: 10,
        },
    )
    .unwrap_or_else(|e| eprintln!("Failed to emit usd-load-progress: {}", e));

    let file_path = Path::new(&path).to_path_buf();
    if !file_path.exists() {
        return Err("File does not exist".into());
    }

    let mut is_usdz = false;
    let mut extracted_dir = None;

    if file_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
        == "usdz"
    {
        is_usdz = true;
        app.emit(
            "usd-load-progress",
            ProgressEvent {
                stage: "Unpacking USDZ Archive...".into(),
                percent: 20,
            },
        )
        .unwrap_or_else(|e| eprintln!("Failed to emit usd-load-progress: {}", e));

        let (new_path, out_d) = unpack_usdz(&path).await?;
        path = new_path;
        extracted_dir = Some(out_d);
    }

    app.emit(
        "usd-load-progress",
        ProgressEvent {
            stage: "Extracting Dependencies".into(),
            percent: 40,
        },
    )
    .unwrap_or_else(|e| eprintln!("Failed to emit usd-load-progress: {}", e));

    let app_state = app.state::<crate::omniverse::AppState>();
    let server_url = app_state
        .omniverse_server
        .lock()
        .map_err(|e| format!("Failed to read omniverse server URL: {}", e))?
        .clone();

    let (scan, stage_info) = match tauri::async_runtime::spawn_blocking({
        let p_str = path.clone();
        let stage_app = app.clone();
        // The open's cleanup-owned extraction dir: the owner thread
        // records it and deletes it on close_stage (the session layer file
        // it knows on its own).
        let open_extraction_dir = extracted_dir.clone();
        move || -> Result<(DependencyScan, crate::stage::StageInfo), String> {
            let handle = std::thread::Builder::new()
                .stack_size(32 * 1024 * 1024)
                .name("usd_deps_parser".into())
                .spawn(move || {
                    let stage_state = stage_app.state::<crate::stage::StageState>();
                    let stage_info = stage_state.open(
                        Path::new(&p_str),
                        is_usdz,
                        is_usdz.then_some(file_path.as_path()),
                        open_extraction_dir.as_deref(),
                    )?;
                    // The scan runs against the stage the open already
                    // parsed, then the remote fetches; both stay off the
                    // async runtime.
                    let scan =
                        dependencies_after_open(&stage_state, stage_info.stage_id, &server_url)?;
                    Ok((scan, stage_info))
                })
                .map_err(|e| format!("Failed to spawn parser thread: {}", e))?;
            handle.join().map_err(|_| PARSER_PANICKED.to_string())?
        }
    })
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => return Err(e),
        Err(e) => return Err(format!("Stack overflow or extraction failed: {}", e)),
    };

    let mut dependencies: HashMap<String, UsdDependencyNode> = scan
        .entries
        .into_iter()
        .map(|entry| (entry.key, entry.node))
        .collect();

    // Fallback: If this was a USDZ archive, simply pre-populate all extracted files into dependencies.
    // Three.js loads the patched blob via object URL, which loses directory context. The URLModifier
    // REQUIRES files to precisely exist in the dependencies map to map back to physical disk.
    // Sometimes the parser misses nested texture paths inside the binary tokens. Walking guarantees it.
    if is_usdz {
        if let Some(out_dir) = extracted_dir {
            for entry in walkdir::WalkDir::new(&out_dir)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                let mut absolute_dep = entry
                    .path()
                    .canonicalize()
                    .unwrap_or_else(|_| entry.path().to_path_buf());

                // Strip UNC prefix which breaks pathdiff and threejs
                let abs_str = absolute_dep
                    .to_string_lossy()
                    .replace("\\\\?\\", "")
                    .replace("//?/", "");
                absolute_dep = std::path::PathBuf::from(&abs_str);

                let mut out_dir_clean = out_dir.canonicalize().unwrap_or_else(|_| out_dir.clone());
                let out_str = out_dir_clean
                    .to_string_lossy()
                    .replace("\\\\?\\", "")
                    .replace("//?/", "");
                out_dir_clean = std::path::PathBuf::from(&out_str);

                let relative_to_root = pathdiff::diff_paths(&absolute_dep, &out_dir_clean)
                    .unwrap_or_else(|| absolute_dep.clone());

                let rel_str = relative_to_root.to_string_lossy().replace("\\", "/");

                let size = fs::metadata(&absolute_dep).map(|m| m.len()).ok();

                dependencies.entry(rel_str.clone()).or_insert_with(|| {
                    crate::models::UsdDependencyNode {
                        path: abs_str.replace("\\", "/"),
                        resolved: true,
                        size_bytes: size,
                        fallback_color: None,
                        error_msg: None,
                    }
                });
            }
        }
    }

    app.emit(
        "usd-load-progress",
        ProgressEvent {
            stage: "Finalizing Metadata".into(),
            percent: 90,
        },
    )
    .unwrap_or_else(|e| eprintln!("Failed to emit usd-load-progress: {}", e));

    let scene = UsdSceneData {
        root_file: path,
        dependencies,
    };

    app.emit(
        "usd-load-progress",
        ProgressEvent {
            stage: "Dispatching Frame".into(),
            percent: 100,
        },
    )
    .unwrap_or_else(|e| eprintln!("Failed to emit usd-load-progress: {}", e));
    app.emit("usd-scene-loaded", scene)
        .unwrap_or_else(|e| eprintln!("Failed to emit usd-scene-loaded: {}", e));
    app.emit("usd-stage-opened", &stage_info)
        .unwrap_or_else(|e| eprintln!("Failed to emit usd-stage-opened: {}", e));
    Ok(stage_info)
}

// The panic message the parser thread's `join` failure already produces.
const PARSER_PANICKED: &str = "The USD parser thread panicked";

/// Runs the open's post-open dependency work behind a panic guard.
///
/// The stage, its session layer file and its extraction dir are all live by
/// the time this work starts, so a panic here would escape as a `join` error
/// and leave them alive for the rest of the session. A panic fails the load
/// like an error does, with the same message the join path reports.
fn guard_post_open<F>(
    stage_state: &crate::stage::StageState,
    stage_id: u64,
    pass: F,
) -> Result<DependencyScan, String>
where
    F: FnOnce() -> Result<DependencyScan, String>,
{
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(pass))
        .unwrap_or_else(|_| Err(PARSER_PANICKED.to_string()));
    if result.is_err() {
        if let Err(e) = stage_state.close_stage(stage_id) {
            eprintln!("usdbee: could not close the stage of a failed load: {}", e);
        }
    }
    result
}

// The open orchestration's post-open dependency work: the owner's scan
// (against the layers the open already parsed) and then the remote fetches.
// A failure of either aborts the load (Phase 0 ruling), and the stage opened
// ahead of the scan must not outlive it — before the scan moved behind the
// open, a failed scan never left a stage behind.
fn dependencies_after_open(
    stage_state: &crate::stage::StageState,
    stage_id: u64,
    server_url: &str,
) -> Result<DependencyScan, String> {
    guard_post_open(stage_state, stage_id, || {
        stage_state.get_dependencies(stage_id).and_then(|mut scan| {
            resolve_remote_dependencies(&mut scan, server_url)?;
            Ok(scan)
        })
    })
}

// Path-based open (drag-drop, recent files): the SAME orchestration the
// dialog flow runs — usdz extraction, dependency scan + remote fetch,
// fallback-color population, usd-load-* events — with the error returned
// to the caller instead of the usd-load-error event.
#[tauri::command]
pub async fn open_usd_file_path<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<StageInfo, String> {
    process_usd_file(app, path).await
}

#[tauri::command]
pub async fn set_fallback_color(path: String, color: String) -> Result<String, String> {
    println!(
        "Replacing missing texture '{}' with fallback color: {}",
        path, color
    );
    Ok(format!("Successfully applied color {} to {}", color, path))
}

#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

pub const EXPORT_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "mp4"];
const MAX_EXPORT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub(crate) fn validate_export(path: &str, bytes: &[u8]) -> Result<(), String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !EXPORT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Unsupported export format '{}'. Allowed formats: {}.",
            ext,
            EXPORT_EXTENSIONS.join(", ")
        ));
    }
    if bytes.is_empty() {
        return Err("Cannot export an empty file.".into());
    }
    if bytes.len() as u64 > MAX_EXPORT_BYTES {
        return Err("Export exceeds the maximum size of 4 GiB.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn save_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    validate_export(&path, &bytes)?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in entries {
            w.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn failed_remote_load_leaves_no_open_stage() {
        use crate::fetcher::{cached_path_for, get_usdbee_cache_dir};
        use crate::stage::{noop_sink, StageState};
        use std::io::Read;

        // A dependency server that refuses the download.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut head = [0; 1024];
                let _ = stream.read(&mut head);
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });

        // The download cache outlives the run, so the URL carries this
        // process's id and its entry is evicted like the parser tests do.
        let url = format!(
            "http://127.0.0.1:{}/remote_{}/tex.png",
            port,
            std::process::id()
        );
        let _ = fs::remove_file(cached_path_for(&url, &get_usdbee_cache_dir()));
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("remote_root.usda");
        fs::write(
            &root,
            format!("#usda 1.0\ndef \"R\"\n{{\n    asset t = @{}@\n}}\n", url),
        )
        .unwrap();

        let state = StageState::new(noop_sink());
        let info = state
            .open(&root, false, None, None)
            .expect("the stage opens before the scan runs");

        let error = dependencies_after_open(&state, info.stage_id, "")
            .err()
            .expect("a failed dependency download must abort the load");
        assert!(
            error.contains("Failed to download"),
            "the error must stay user-readable, got: {}",
            error
        );
        assert!(
            state.sender(info.stage_id).is_err(),
            "the aborted load must not leave its stage open"
        );
        assert!(state.list_stages().unwrap().is_empty());
    }

    #[test]
    fn panicked_post_open_pass_leaves_no_open_stage() {
        use crate::stage::{noop_sink, StageState};

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("plain.usda");
        fs::write(&root, "#usda 1.0\ndef \"R\"\n{\n}\n").unwrap();

        let state = StageState::new(noop_sink());
        let info = state
            .open(&root, false, None, None)
            .expect("the stage opens before the pass runs");

        let error = guard_post_open(&state, info.stage_id, || panic!("scan exploded"))
            .err()
            .expect("a panicked pass must fail the load, not escape the thread");
        assert_eq!(
            error, PARSER_PANICKED,
            "the panic surfaces as the join path's error"
        );
        assert!(
            state.sender(info.stage_id).is_err(),
            "a panicked load must not leave its stage open"
        );
        assert!(state.list_stages().unwrap().is_empty());
    }

    #[test]
    fn export_rejects_unlisted_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload.sh");

        let result = validate_export(path.to_string_lossy().as_ref(), b"evil".as_slice());

        assert!(result.is_err(), ".sh export must be rejected");
        assert!(
            result.unwrap_err().contains("png"),
            "error must list allowed extension"
        );
    }

    #[test]
    fn export_rejects_extensionless_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload");

        let result = validate_export(path.to_string_lossy().as_ref(), b"data".as_slice());

        assert!(result.is_err(), "extensionless export must be rejected");
    }

    #[test]
    fn export_rejects_empty_payload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload.png");

        let result = validate_export(path.to_string_lossy().as_ref(), b"".as_slice());

        assert!(result.is_err(), "empty payload must be rejected");
    }

    #[test]
    fn export_accepts_whitelisted_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload.png");

        let result = validate_export(path.to_string_lossy().as_ref(), b"png data".as_slice());

        assert!(result.is_ok(), "whitelisted export must pass validation");
    }

    #[test]
    fn rejects_parent_traversal() {
        let out = Path::new("/tmp/out");
        assert_eq!(sanitize_entry_name("../../evil.txt", out), None);
    }

    #[test]
    fn rejects_absolute_path() {
        let out = Path::new("/tmp/out");
        assert_eq!(sanitize_entry_name("/etc/evil", out), None);
    }

    #[test]
    fn rejects_windows_drive_letter() {
        let out = Path::new("/tmp/out");
        assert_eq!(sanitize_entry_name("C:\\evil.txt", out), None);
    }

    #[test]
    fn accepts_nested_relative_entry() {
        let out = Path::new("/tmp/out");
        assert_eq!(
            sanitize_entry_name("assets/model.usdc", out),
            Some(out.join("assets/model.usdc"))
        );
    }

    #[test]
    fn load_gate_serializes_concurrent_claims() {
        let gate = LoadGate::default();
        let first = gate.claim().expect("first claim must succeed");
        assert!(gate.claim().is_none(), "a second claim must be refused");
        drop(first);
        assert!(gate.claim().is_some(), "release must reopen the gate");
    }

    #[test]
    fn gate_refusal_never_rides_the_dialog_failure_channel() {
        assert_eq!(dialog_load_error(OPEN_IN_FLIGHT_MESSAGE), None);
        assert_eq!(
            dialog_load_error("File does not exist"),
            Some("File does not exist".to_string())
        );
    }

    #[test]
    fn accepts_dot_prefixed_entry() {
        let out = Path::new("/tmp/out");
        assert_eq!(
            sanitize_entry_name("./ok.usda", out),
            Some(out.join("ok.usda"))
        );
    }

    #[test]
    fn traversal_entry_aborts_extraction() {
        let bytes = make_zip(&[
            ("../traversal.txt", b"pwn"),
            ("assets/model.usda", b"usd data"),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let outside_dir = tmp.path().parent().unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();

        let result = extract_archive(&mut archive, tmp.path());

        assert!(result.is_err(), "traversal entry must abort extraction");
        assert!(!tmp.path().join("traversal.txt").exists());
        assert!(!outside_dir.join("traversal.txt").exists());
    }

    #[test]
    fn valid_archive_extracts_and_picks_root_file() {
        let bytes = make_zip(&[
            ("assets/model.usda", b"usd data"),
            ("assets/texture.png", b"png data"),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();

        let root = extract_archive(&mut archive, tmp.path()).unwrap();

        assert_eq!(root, tmp.path().join("assets/model.usda").to_string_lossy());
        assert!(tmp.path().join("assets/model.usda").exists());
        assert!(tmp.path().join("assets/texture.png").exists());
    }

    #[test]
    fn rejected_archive_after_valid_entry_leaves_no_output_dir() {
        let bytes = make_zip(&[
            ("assets/model.usda", b"usd data"),
            ("../traversal.txt", b"pwn"),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let out_dir = tmp.path().join("extracted");
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();

        let result = extract_archive(&mut archive, &out_dir);

        assert!(result.is_err(), "traversal entry must abort extraction");
        assert!(
            !out_dir.exists(),
            "a rejected archive must not leave partially extracted content"
        );
    }
}
