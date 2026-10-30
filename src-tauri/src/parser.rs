use crate::fetcher::{fetch_and_cache_url, get_usdbee_cache_dir};
use crate::models::UsdDependencyNode;
use crate::omniverse::resolve_omniverse_uri;

use regex::bytes::Regex as BytesRegex;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub fn extract_dependencies(
    file_path: &Path,
    server_url: &str,
) -> Result<HashMap<String, UsdDependencyNode>, String> {
    let mut deps = HashMap::new();
    let mut visited = std::collections::HashSet::new();
    let original_root = file_path
        .parent()
        .unwrap_or(Path::new(""))
        .canonicalize()
        .unwrap_or_else(|_| Path::new("").to_path_buf());

    let root_str = original_root
        .to_string_lossy()
        .replace("\\\\?\\", "")
        .replace("//?/", "");
    let root_dir = PathBuf::from(&root_str);

    let mut queue = vec![file_path.to_path_buf()];

    // Hoisted: compiling these per scanned file made clippy's regex-in-loop fire.
    let re_usda = BytesRegex::new(r#"@([^@\n\r"']+)@"#).ok();
    let re_fallback = BytesRegex::new(
        r#"([a-zA-Z0-9_/\\\.\-\ ]+\.(?:png|jpg|jpeg|exr|tif|tiff|usd|usda|usdc|usdz))"#,
    )
    .ok();

    while let Some(current_path) = queue.pop() {
        if !current_path.exists() {
            continue;
        }

        let absolute_path = match current_path.canonicalize() {
            Ok(p) => p
                .to_string_lossy()
                .replace("\\\\?\\", "")
                .replace("//?/", ""),
            Err(_) => current_path
                .to_string_lossy()
                .replace("\\\\?\\", "")
                .replace("//?/", ""),
        };

        if visited.contains(&absolute_path) {
            continue;
        }
        visited.insert(absolute_path.clone());

        let ext = current_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let is_zip = ext == "usdz";

        if is_zip {
            if let Ok(file) = fs::File::open(&current_path) {
                if let Ok(mut archive) = zip::ZipArchive::new(file) {
                    for i in 0..archive.len() {
                        if let Ok(file_in_zip) = archive.by_index(i) {
                            let name = file_in_zip.name().to_string();
                            if name.ends_with('/') || name.is_empty() {
                                continue;
                            }
                            let size = file_in_zip.size();

                            deps.insert(
                                name.clone(),
                                UsdDependencyNode {
                                    path: name,
                                    resolved: true,
                                    size_bytes: Some(size),
                                    fallback_color: None,
                                    error_msg: None,
                                },
                            );
                        }
                    }
                }
            }
        } else {
            if let Ok(content) = fs::read(&current_path) {
                let mut found_paths = std::collections::HashSet::new();

                if ext == "usda" || content.starts_with(b"#usda") {
                    if let Some(re) = &re_usda {
                        for caps in re.captures_iter(&content) {
                            if let Ok(p) = std::str::from_utf8(&caps[1]) {
                                found_paths.insert(p.trim().to_string());
                            }
                        }
                    }
                } else if content.starts_with(b"PXR-USDC") {
                    if let Ok(crate_file) =
                        openusd::usdc::CrateFile::open(std::io::Cursor::new(&content))
                    {
                        for token in crate_file.tokens {
                            let token_lower = token.to_lowercase();
                            if token_lower.ends_with(".usd")
                                || token_lower.ends_with(".usda")
                                || token_lower.ends_with(".usdc")
                                || token_lower.ends_with(".usdz")
                                || token_lower.ends_with(".png")
                                || token_lower.ends_with(".jpg")
                                || token_lower.ends_with(".jpeg")
                                || token_lower.ends_with(".exr")
                                || token_lower.ends_with(".tif")
                                || token_lower.ends_with(".tiff")
                            {
                                found_paths.insert(token);
                            }
                        }
                    }
                } else {
                    if let Some(re) = &re_fallback {
                        for caps in re.captures_iter(&content) {
                            if let Ok(p) = std::str::from_utf8(&caps[1]) {
                                found_paths.insert(p.trim().to_string());
                            }
                        }
                    }
                }

                let current_dir = current_path.parent().unwrap_or(Path::new(""));
                let file_name = current_path
                    .file_name()
                    .unwrap_or_default()
                    .to_str()
                    .unwrap_or("");

                for mut p in found_paths {
                    if p.is_empty() || p == file_name {
                        continue;
                    }

                    let original_p = p.clone(); // Keep original for key

                    if p.starts_with("omni:") || p.starts_with("omniverse:") {
                        p = resolve_omniverse_uri(&p, server_url);
                    }

                    if p.starts_with("http://")
                        || p.starts_with("https://")
                        || p.starts_with("http:/")
                        || p.starts_with("https:/")
                    {
                        let mut url = p.clone();
                        if url.starts_with("http:/") && !url.starts_with("http://") {
                            url = url.replacen("http:/", "http://", 1);
                        } else if url.starts_with("https:/") && !url.starts_with("https://") {
                            url = url.replacen("https:/", "https://", 1);
                        }

                        let cache_dir = get_usdbee_cache_dir();
                        fs::create_dir_all(&cache_dir).ok();

                        // A failed remote fetch fails the whole load: the
                        // caller turns this error into a usd-load-error event
                        // instead of a silently unresolved dependency.
                        let absolute_dep = fetch_and_cache_url(&url, &cache_dir)?;

                        let resolved = absolute_dep.exists();
                        let size = if resolved {
                            fs::metadata(&absolute_dep).map(|m| m.len()).ok()
                        } else {
                            None
                        };

                        deps.insert(
                            original_p.clone(),
                            UsdDependencyNode {
                                path: absolute_dep.to_string_lossy().to_string(),
                                resolved,
                                size_bytes: size,
                                fallback_color: None,
                                error_msg: None,
                            },
                        );
                        continue;
                    }

                    let clean_p = p.replace("\\", "/");
                    let mut dep_path = current_dir.join(&clean_p);

                    if !dep_path.exists() {
                        let root_dep = root_dir.join(&clean_p);
                        if root_dep.exists() {
                            dep_path = root_dep;
                        }
                    }

                    let mut error_msg = None;
                    let absolute_dep = match dep_path.canonicalize() {
                        Ok(p) => {
                            let clean = p
                                .to_string_lossy()
                                .replace("\\\\?\\", "")
                                .replace("//?/", "");
                            PathBuf::from(&clean)
                        }
                        Err(e) => {
                            error_msg = Some(format!(
                                "Failed to resolve path:\n{} \nError: {}",
                                dep_path.display(),
                                e
                            ));
                            dep_path.clone()
                        }
                    };

                    let relative_to_root = pathdiff::diff_paths(&absolute_dep, &root_dir)
                        .unwrap_or_else(|| dep_path.clone());

                    let relative_to_root_str =
                        relative_to_root.to_string_lossy().replace("\\", "/");

                    let resolved = absolute_dep.exists();
                    let size = if resolved {
                        fs::metadata(&absolute_dep).map(|m| m.len()).ok()
                    } else {
                        if error_msg.is_none() {
                            error_msg = Some("File not found at resolved location".to_string());
                        }
                        None
                    };

                    deps.insert(
                        relative_to_root_str.clone(),
                        UsdDependencyNode {
                            path: absolute_dep.to_string_lossy().replace("\\", "/"),
                            resolved,
                            size_bytes: size,
                            fallback_color: None,
                            error_msg,
                        },
                    );

                    if resolved {
                        queue.push(absolute_dep);
                    }
                }
            }
        }
    }

    Ok(deps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    // One-shot local HTTP server so remote-dependency handling is exercised
    // against the real ureq path without network access.
    fn spawn_http_server(response: &'static [u8]) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut conn, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = conn.read(&mut buf); // drain request head; ignore errors
                let _ = conn.write_all(response);
            }
        });
        port
    }

    fn write_usda(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn detects_local_references_and_recurses() {
        let dir = tempfile::tempdir().unwrap();
        write_usda(
            dir.path(),
            "root.usda",
            "#usda 1.0\n(references = @./a.usda@)\n",
        );
        write_usda(
            dir.path(),
            "a.usda",
            "#usda 1.0\n(references = @./b.usda@)\n",
        );
        write_usda(dir.path(), "b.usda", "#usda 1.0\n");

        let deps = extract_dependencies(&dir.path().join("root.usda"), "").unwrap();

        let a = deps
            .get("a.usda")
            .expect("direct local reference must be detected");
        assert!(a.resolved, "a.usda exists and must be resolved");
        assert!(a.error_msg.is_none());

        let b = deps
            .get("b.usda")
            .expect("scan must recurse into referenced files");
        assert!(b.resolved);
    }

    #[test]
    fn missing_local_reference_recorded_unresolved() {
        let dir = tempfile::tempdir().unwrap();
        write_usda(
            dir.path(),
            "root.usda",
            "#usda 1.0\n(references = @./missing.usda@)\n",
        );

        let deps = extract_dependencies(&dir.path().join("root.usda"), "").unwrap();

        // Recorded actual behavior: the dep is keyed by its root-relative path,
        // reported unresolved with a canonicalize error message. It is not
        // scanned further and does not fail the whole scan.
        let dep = deps
            .get("missing.usda")
            .expect("missing local reference must appear in deps");
        assert!(!dep.resolved);
        assert!(dep.error_msg.is_some());
        assert_eq!(deps.len(), 1);
    }

    #[test]
    fn remote_fetch_failure_fails_the_scan() {
        let port = spawn_http_server(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let dir = tempfile::tempdir().unwrap();
        write_usda(
            dir.path(),
            "root.usda",
            &format!("#usda 1.0\n(asset = @http://127.0.0.1:{}/tex.png@)\n", port),
        );

        let result = extract_dependencies(&dir.path().join("root.usda"), "");

        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("a failed dependency download must fail the whole load"),
        };
        assert!(
            err.contains("Failed to download"),
            "error must stay user-readable, got: {}",
            err
        );
    }

    #[test]
    fn remote_fetch_success_resolves_dependency() {
        let port = spawn_http_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nusdbytes",
        );
        let dir = tempfile::tempdir().unwrap();
        let url = format!("http://127.0.0.1:{}/tex.png", port);
        write_usda(
            dir.path(),
            "root.usda",
            &format!("#usda 1.0\n(asset = @{}@)\n", url),
        );

        let deps = extract_dependencies(&dir.path().join("root.usda"), "").unwrap();

        let dep = deps
            .get(&url)
            .expect("remote dep is keyed by its original URL");
        assert!(dep.resolved, "fetched dep must resolve to the cache file");
        assert_eq!(dep.size_bytes, Some(8));
        assert!(dep.error_msg.is_none());
    }
}
