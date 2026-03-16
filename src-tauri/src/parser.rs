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
                    if let Ok(re_usda) = BytesRegex::new(r#"@([^@\n\r"']+)@"#) {
                        for caps in re_usda.captures_iter(&content) {
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
                    if let Ok(re_fallback) = BytesRegex::new(
                        r#"([a-zA-Z0-9_/\\\.\-\ ]+\.(?:png|jpg|jpeg|exr|tif|tiff|usd|usda|usdc|usdz))"#,
                    ) {
                        for caps in re_fallback.captures_iter(&content) {
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

                        let mut error_msg = None;
                        let absolute_dep = match fetch_and_cache_url(&url, &cache_dir) {
                            Ok(p) => p,
                            Err(e) => {
                                error_msg = Some(e);
                                PathBuf::from(&url)
                            }
                        };

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
                                error_msg,
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
