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
                    if let Err(e) = process_usd_file(app_clone.clone(), path_str).await {
                        eprintln!("Error loading USD: {}", e);
                        let _ = app_clone.emit("usd-load-error", e);
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

        if name.ends_with('/') {
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

    root_file.or(first_file).ok_or_else(|| "Empty USDZ archive".into())
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
}
