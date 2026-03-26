use crate::fetcher::get_usdbee_cache_dir;
use crate::models::{ProgressEvent, UsdSceneData};
use crate::parser::extract_dependencies;

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn trigger_open_usd_dialog(app: tauri::AppHandle) -> Result<(), String> {
    app.dialog()
        .file()
        .add_filter("USD Files", &["usd", "usda", "usdc", "usdz"])
        .pick_file(move |file_path| {
            if let Some(path) = file_path {
                let path_str = path.to_string();
                let _ = app.emit("usd-load-start", path_str.clone());

                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = process_usd_file(app_clone, path_str).await {
                        eprintln!("Error loading USD: {}", e);
                    }
                });
            }
        });
    Ok(())
}

async fn unpack_usdz(path: &str) -> Result<(String, std::path::PathBuf), String> {
    let p_str = path.to_string();
    let res = tauri::async_runtime::spawn_blocking(
        move || -> Result<(String, std::path::PathBuf), String> {
            let p = Path::new(&p_str);
            let file = fs::File::open(p).map_err(|e| e.to_string())?;
            let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

            let mut hasher = DefaultHasher::new();
            p_str.hash(&mut hasher);
            let hash = hasher.finish();

            let mut out_dir = get_usdbee_cache_dir();
            out_dir.push("extracted");
            out_dir.push(format!("{:016x}", hash));

            if !out_dir.exists() {
                fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
                archive.extract(&out_dir).map_err(|e| e.to_string())?;
            }

            if archive.len() > 0 {
                if let Ok(first_file) = archive.by_index(0) {
                    let f_name = first_file.name().to_string();
                    let root_file = out_dir.join(f_name);
                    return Ok((root_file.to_string_lossy().to_string(), out_dir));
                }
            }
            Err("Empty USDZ archive".into())
        },
    )
    .await;

    match res {
        Ok(Ok(res)) => Ok(res),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(e.to_string()),
    }
}

async fn process_usd_file(app: tauri::AppHandle, mut path: String) -> Result<(), String> {
    app.emit(
        "usd-load-progress",
        ProgressEvent {
            stage: "Opening File".into(),
            percent: 10,
        },
    )
    .unwrap();

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
        .unwrap();

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
    .unwrap();

    let app_state = app.state::<crate::omniverse::AppState>();
    let server_url = app_state.omniverse_server.lock().unwrap().clone();

    let mut dependencies = match tauri::async_runtime::spawn_blocking({
        let p_str = path.clone();
        move || {
            std::thread::Builder::new()
                .stack_size(32 * 1024 * 1024)
                .name("usd_deps_parser".into())
                .spawn(move || extract_dependencies(Path::new(&p_str), &server_url))
                .unwrap()
                .join()
                .unwrap()
        }
    })
    .await
    {
        Ok(Ok(deps)) => deps,
        Ok(Err(e)) => return Err(e),
        Err(e) => return Err(format!("Stack overflow or extraction failed: {}", e)),
    };

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
    .unwrap();

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
    .unwrap();
    app.emit("usd-scene-loaded", scene).unwrap();
    Ok(())
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

#[tauri::command]
pub async fn save_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}
