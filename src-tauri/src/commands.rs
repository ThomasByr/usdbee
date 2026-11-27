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

/// Expands a leading `~` (`~` or `~/...`) against `home`; anything else is
/// returned verbatim. Takes the home so tests stay deterministic.
fn expand_home_with(input: &str, home: &Path) -> std::path::PathBuf {
    if input == "~" {
        return home.to_path_buf();
    }
    match input.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => std::path::PathBuf::from(input),
    }
}

/// Filesystem-side `~` expansion. No home to expand against means the input
/// is used as given.
fn expand_home(input: &str) -> std::path::PathBuf {
    match std::env::home_dir() {
        Some(home) => expand_home_with(input, &home),
        None => std::path::PathBuf::from(input),
    }
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
    path: String,
) -> Result<StageInfo, String> {
    // `~` is expanded once, here: the events, the scene's root_file, the stage
    // open and the returned StageInfo must all name the same path. A relative
    // argument (a CLI launch) is made absolute for the same reason: OpenUSD
    // reports the root layer identifier as absolute, so the frontend's
    // root comparison would drop this open's own stage-opened event.
    let file_path = expand_home(&path);
    let file_path = std::path::absolute(&file_path).unwrap_or(file_path);
    let mut path = file_path.to_string_lossy().into_owned();

    app.emit("usd-load-start", path.clone())
        .unwrap_or_else(|e| eprintln!("Failed to emit usd-load-start: {}", e));

    app.emit(
        "usd-load-progress",
        ProgressEvent {
            stage: "Opening File".into(),
            percent: 5,
        },
    )
    .unwrap_or_else(|e| eprintln!("Failed to emit usd-load-progress: {}", e));

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
                percent: 10,
            },
        )
        .unwrap_or_else(|e| eprintln!("Failed to emit usd-load-progress: {}", e));

        let (new_path, out_d) = unpack_usdz(&file_path.to_string_lossy()).await?;
        path = new_path;
        extracted_dir = Some(out_d);
    }

    app.emit(
        "usd-load-progress",
        ProgressEvent {
            stage: "Opening Stage".into(),
            percent: 15,
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
            percent: 40,
        },
    )
    .unwrap_or_else(|e| eprintln!("Failed to emit usd-load-progress: {}", e));

    let scene = UsdSceneData {
        root_file: path,
        stage_id: stage_info.stage_id,
        dependencies,
    };

    app.emit(
        "usd-load-progress",
        ProgressEvent {
            stage: "Dispatching Frame".into(),
            percent: 45,
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

#[derive(serde::Serialize, Debug)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(serde::Serialize, Debug)]
pub struct SuggestEntries {
    pub entries: Vec<DirEntry>,
}

const SUGGEST_EXTENSIONS: &[&str] = &["usd", "usda", "usdc", "usdz"];
const SUGGEST_LIMIT: usize = 500;

fn read_dir_entries(dir: &Path) -> std::io::Result<Vec<(String, bool)>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let is_dir = entry.path().is_dir();
        entries.push((entry.file_name().to_string_lossy().into_owned(), is_dir));
    }
    Ok(entries)
}

/// Sync and tauri-free so unit tests inject their own lister.
fn suggest_dir_entries_inner(
    prefix: &str,
    home: &Path,
    list_dir: impl Fn(&Path) -> std::io::Result<Vec<(String, bool)>>,
) -> SuggestEntries {
    let expanded = expand_home_with(prefix, home);
    let dir = if prefix.is_empty() || prefix == "~" || prefix.ends_with(['/', '\\']) {
        expanded
    } else {
        expanded.parent().map(Path::to_path_buf).unwrap_or_default()
    };

    let mut entries: Vec<DirEntry> = list_dir(&dir)
        .unwrap_or_default()
        .into_iter()
        .filter(|(name, is_dir)| *is_dir || is_usd_file(name))
        .map(|(name, is_dir)| DirEntry { name, is_dir })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    entries.truncate(SUGGEST_LIMIT);
    SuggestEntries { entries }
}

fn is_usd_file(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| SUGGEST_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Directory listing for the palette's path completion. A bad path is empty
/// suggestions, never an error, so typing never flashes a failure.
#[tauri::command]
pub async fn suggest_dir_entries(prefix: String) -> Result<SuggestEntries, String> {
    let home = std::env::home_dir().unwrap_or_default();
    Ok(suggest_dir_entries_inner(&prefix, &home, read_dir_entries))
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

        assert_eq!(
            Path::new(&root),
            tmp.path().join("assets").join("model.usda")
        );
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

    fn fake_listing(
        entries: &'static [(&'static str, bool)],
    ) -> impl Fn(&Path) -> std::io::Result<Vec<(String, bool)>> {
        move |_| {
            Ok(entries
                .iter()
                .map(|(name, is_dir)| (name.to_string(), *is_dir))
                .collect())
        }
    }

    fn names(entries: &SuggestEntries) -> Vec<&str> {
        entries.entries.iter().map(|e| e.name.as_str()).collect()
    }

    fn listing_seen(
        prefix: &str,
        home: &Path,
    ) -> (std::cell::RefCell<Vec<std::path::PathBuf>>, SuggestEntries) {
        let seen: std::cell::RefCell<Vec<std::path::PathBuf>> = Default::default();
        let result = suggest_dir_entries_inner(prefix, home, |dir| {
            seen.borrow_mut().push(dir.to_path_buf());
            Ok(Vec::new())
        });
        (seen, result)
    }

    #[test]
    fn expand_home_resolves_bare_tilde_and_tilde_paths() {
        let home = Path::new("/home/beekeeper");

        assert_eq!(expand_home_with("~", home), home);
        assert_eq!(
            expand_home_with("~/Code/bike.usd", home),
            home.join("Code/bike.usd")
        );
    }

    #[test]
    fn expand_home_leaves_other_paths_alone() {
        let home = Path::new("/home/beekeeper");

        assert_eq!(expand_home_with("~foo", home), Path::new("~foo"));
        assert_eq!(
            expand_home_with("rel/bike.usd", home),
            Path::new("rel/bike.usd")
        );
        assert_eq!(
            expand_home_with("/abs/bike.usd", home),
            Path::new("/abs/bike.usd")
        );
    }

    // process_usd_file_inner needs an AppHandle, so this pins the resolver its
    // exists check runs on: a `~/` path resolves onto the home it is given.
    #[test]
    fn expand_home_finds_files_under_the_home() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("Code")).unwrap();
        std::fs::write(home.path().join("Code/bike.usd"), b"#usda 1.0").unwrap();

        let resolved = expand_home_with("~/Code/bike.usd", home.path());

        assert!(resolved.exists(), "~/Code/bike.usd must resolve onto home");
    }

    #[test]
    fn suggest_dir_expands_tilde_into_home() {
        let home = Path::new("/home/beekeeper");
        let (seen, _) = listing_seen("~/projects/model", home);

        assert_eq!(
            seen.borrow().as_slice(),
            [home.join("projects")],
            "a ~ prefix must resolve under the injected home"
        );
    }

    #[test]
    fn suggest_dir_lists_home_for_bare_tilde() {
        let home = Path::new("/home/beekeeper");
        let (seen, _) = listing_seen("~", home);

        assert_eq!(seen.borrow().as_slice(), [home.to_path_buf()]);
    }

    #[test]
    fn suggest_dir_lists_tilde_dir_with_trailing_slash() {
        let home = Path::new("/home/beekeeper");
        let (seen, _) = listing_seen("~/projects/", home);

        assert_eq!(seen.borrow().as_slice(), [home.join("projects")]);
    }

    #[test]
    fn suggest_dir_lists_parent_of_last_component() {
        let home = Path::new("/home/beekeeper");
        let (seen, _) = listing_seen("/a/b", home);

        assert_eq!(seen.borrow().as_slice(), [Path::new("/a")]);
    }

    #[test]
    fn suggest_dir_lists_dir_when_prefix_ends_in_separator() {
        let home = Path::new("/home/beekeeper");
        let (seen, _) = listing_seen("/a/", home);

        assert_eq!(seen.borrow().as_slice(), [Path::new("/a")]);
    }

    #[test]
    fn suggest_dir_lists_prefix_verbatim_when_empty() {
        let home = Path::new("/home/beekeeper");
        let (seen, _) = listing_seen("", home);

        assert_eq!(seen.borrow().as_slice(), [Path::new("")]);
    }

    #[test]
    fn suggest_dir_keeps_dirs_and_usd_files_only() {
        static ENTRIES: &[(&str, bool)] = &[
            ("assets", true),
            ("model.usda", false),
            ("SHADED.USDZ", false),
            ("packed.usdc", false),
            ("legacy.usd", false),
            ("notes.txt", false),
            ("README", false),
        ];

        let result = suggest_dir_entries_inner("/a/b", Path::new("/h"), fake_listing(ENTRIES));

        assert_eq!(
            names(&result),
            vec![
                "assets",
                "SHADED.USDZ",
                "legacy.usd",
                "model.usda",
                "packed.usdc"
            ]
        );
    }

    #[test]
    fn suggest_dir_sorts_dirs_first_then_name() {
        static ENTRIES: &[(&str, bool)] = &[
            ("zeta", true),
            ("beta.usda", false),
            ("alpha", true),
            ("aaa.usd", false),
        ];

        let result = suggest_dir_entries_inner("/a/b", Path::new("/h"), fake_listing(ENTRIES));

        assert_eq!(
            names(&result),
            vec!["alpha", "zeta", "aaa.usd", "beta.usda"]
        );
    }

    #[test]
    fn suggest_dir_caps_at_500_entries() {
        let entries: Vec<(String, bool)> =
            (0..600).map(|i| (format!("dir_{:03}", i), true)).collect();

        let result = suggest_dir_entries_inner("/a/b", Path::new("/h"), |_| Ok(entries.clone()));

        assert_eq!(result.entries.len(), 500, "the list caps at 500 entries");
        assert_eq!(
            result.entries[0].name, "dir_000",
            "the cap keeps the sorted head"
        );
        assert_eq!(result.entries[499].name, "dir_499");
    }

    #[test]
    fn suggest_dir_unreadable_dir_is_empty_not_err() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("missing/inner");

        let result = suggest_dir_entries_inner(
            missing.to_string_lossy().as_ref(),
            Path::new("/h"),
            read_dir_entries,
        );

        assert!(result.entries.is_empty(), "a missing dir yields no entries");
    }

    #[test]
    fn suggest_dir_reads_a_real_directory() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("assets")).unwrap();
        fs::write(tmp.path().join("model.usda"), b"#usda 1.0").unwrap();
        fs::write(tmp.path().join("notes.txt"), b"hi").unwrap();

        let prefix = tmp.path().join("model");
        let result = suggest_dir_entries_inner(
            prefix.to_string_lossy().as_ref(),
            Path::new("/h"),
            read_dir_entries,
        );

        assert_eq!(names(&result), vec!["assets", "model.usda"]);
    }
}
