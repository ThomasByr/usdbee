use crate::fetcher::{cached_path_for, fetch_and_cache_url, get_usdbee_cache_dir};
use crate::models::UsdDependencyNode;
use crate::omniverse::resolve_omniverse_uri;

use openusd::usd::Stage;
use openusd::usd_utils::compute_all_dependencies;
use std::fs;
use std::path::{Path, PathBuf};

/// One dependency of a scanned scene, in the shape the `usd-scene-loaded`
/// event's dependency map already consumes.
#[derive(Debug)]
pub struct DependencyEntry {
    /// Map key: the root-relative path, or the original remote URL.
    pub key: String,
    pub node: UsdDependencyNode,
}

/// What a scene depends on, in openusd's discovery order: layers first,
/// then other assets, then unresolvable paths.
pub struct DependencyScan {
    pub root: PathBuf,
    pub entries: Vec<DependencyEntry>,
}

/// Scans every layer and asset `root` reaches, through openusd's
/// `compute_all_dependencies`. Local paths are reported in full; remote
/// dependencies (http(s), omniverse) are reported as pending entries that
/// [`resolve_remote_dependencies`] fetches.
pub fn scan_dependencies(root: &Path) -> Result<DependencyScan, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {}: {}", root.display(), e))?;
    let root_str = clean(&root.to_string_lossy());

    let stage = Stage::open(&root_str)
        .map_err(|e| format!("Failed to open USD stage {}: {}", root_str, e))?;
    let deps = compute_all_dependencies(&stage, &root_str)
        .map_err(|e| format!("Failed to compute dependencies of {}: {}", root_str, e))?;

    let root_dir = root.parent().unwrap_or(Path::new(""));

    // layers[0] is the root itself; the entries are what it reaches.
    let mut entries = Vec::new();
    for identifier in deps.layers.iter().skip(1).chain(&deps.assets) {
        let path = clean(identifier);
        let size = fs::metadata(identifier).map(|m| m.len()).ok();
        entries.push(DependencyEntry {
            key: relative_key(identifier, root_dir),
            node: UsdDependencyNode {
                path,
                resolved: true,
                size_bytes: size,
                fallback_color: None,
                error_msg: None,
            },
        });
    }
    for identifier in &deps.unresolved {
        if let Some(url) = remote_url(identifier) {
            entries.push(DependencyEntry {
                key: url.clone(),
                node: UsdDependencyNode {
                    path: url,
                    resolved: false,
                    size_bytes: None,
                    fallback_color: None,
                    error_msg: None,
                },
            });
        } else {
            entries.push(DependencyEntry {
                key: relative_key(identifier, root_dir),
                node: UsdDependencyNode {
                    path: clean(identifier),
                    resolved: false,
                    size_bytes: None,
                    fallback_color: None,
                    error_msg: Some("File not found at resolved location".to_string()),
                },
            });
        }
    }

    Ok(DependencyScan { root, entries })
}

/// Fetches the remote dependencies a scan found into the download cache.
/// A failed fetch aborts the whole load: the caller turns this error into a
/// usd-load-error event instead of a silently unresolved dependency.
pub fn resolve_remote_dependencies(
    scan: &mut DependencyScan,
    server_url: &str,
) -> Result<(), String> {
    if !scan.entries.iter().any(|e| is_remote(&e.key)) {
        return Ok(());
    }
    let cache_dir = get_usdbee_cache_dir();
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create cache directory: {}", e))?;

    for entry in &mut scan.entries {
        if !is_remote(&entry.key) {
            continue;
        }
        let url = &entry.key;
        let target = if url.starts_with("omni://") || url.starts_with("omniverse://") {
            resolve_omniverse_uri(url, server_url)
        } else {
            url.clone()
        };

        let absolute_dep = fetch_and_cache_url(&target, &cache_dir)?;
        let resolved = absolute_dep.exists();
        let size = if resolved {
            fs::metadata(&absolute_dep).map(|m| m.len()).ok()
        } else {
            None
        };

        entry.node.path = clean(&absolute_dep.to_string_lossy());
        entry.node.resolved = resolved;
        entry.node.size_bytes = size;
    }
    Ok(())
}

/// The `http(s)`/omniverse URL an unresolved identifier names, if any.
/// openusd's resolver reads `http://a/b` as the relative path `http:/a/b`,
/// so both spellings restore to the URL as authored.
fn remote_url(identifier: &str) -> Option<String> {
    for (single, double) in [
        ("http:/", "http://"),
        ("https:/", "https://"),
        ("omni:/", "omni://"),
        ("omniverse:/", "omniverse://"),
    ] {
        if let Some(rest) = identifier.strip_prefix(single) {
            return if rest.starts_with('/') {
                Some(identifier.to_string())
            } else {
                Some(format!("{double}{rest}"))
            };
        }
    }
    None
}

fn is_remote(identifier: &str) -> bool {
    remote_url(identifier).is_some()
}

/// `identifier` spelled relative to the root layer's directory, the key the
/// frontend's dependency map and URLModifier expect.
fn relative_key(identifier: &str, root_dir: &Path) -> String {
    let path = Path::new(identifier);
    let relative = if path.is_absolute() {
        pathdiff::diff_paths(path, root_dir).unwrap_or_else(|| path.to_path_buf())
    } else {
        path.to_path_buf()
    };
    clean(&relative.to_string_lossy())
}

/// Strips Windows UNC prefixes and normalizes separators to `/`.
fn clean(path: &str) -> String {
    path.replace("\\\\?\\", "")
        .replace("//?/", "")
        .replace('\\', "/")
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

    // The download cache persists across runs and is keyed by URL hash, and
    // these tests' URLs embed an ephemeral port. A stale entry from a previous
    // run that rebound the same port makes fetch_and_cache_url skip the HTTP
    // call entirely — that short-circuit was the original flake in the 404
    // test. Evicting each remote URL's entry keeps every run on the wire.
    fn evict_cached_download(url: &str) {
        let _ = fs::remove_file(cached_path_for(url, &get_usdbee_cache_dir()));
    }

    fn resolve_remote(scan: &mut DependencyScan) -> Result<(), String> {
        for url in scan
            .entries
            .iter()
            .filter(|e| is_remote(&e.key))
            .map(|e| e.key.clone())
        {
            evict_cached_download(&url);
        }
        resolve_remote_dependencies(scan, "")
    }

    fn scan(dir: &Path, name: &str) -> DependencyScan {
        scan_dependencies(&dir.join(name)).unwrap()
    }

    #[test]
    fn detects_local_references_and_recurses() {
        let dir = tempfile::tempdir().unwrap();
        write_usda(
            dir.path(),
            "root.usda",
            "#usda 1.0\ndef \"R\" (references = @./a.usda@)\n{\n}\n",
        );
        write_usda(
            dir.path(),
            "a.usda",
            "#usda 1.0\ndef \"A\" (references = @./b.usda@)\n{\n}\n",
        );
        write_usda(dir.path(), "b.usda", "#usda 1.0\ndef \"B\"\n{\n}\n");

        let deps = scan(dir.path(), "root.usda");

        let a = deps
            .entries
            .iter()
            .find(|e| e.key == "a.usda")
            .expect("direct local reference must be detected");
        assert!(a.node.resolved, "a.usda exists and must be resolved");
        assert!(a.node.error_msg.is_none());

        let b = deps
            .entries
            .iter()
            .find(|e| e.key == "b.usda")
            .expect("scan must recurse into referenced files");
        assert!(b.node.resolved);
    }

    #[test]
    fn missing_local_reference_recorded_unresolved() {
        let dir = tempfile::tempdir().unwrap();
        write_usda(
            dir.path(),
            "root.usda",
            "#usda 1.0\ndef \"R\" (references = @./missing.usda@)\n{\n}\n",
        );

        let deps = scan(dir.path(), "root.usda");

        // A missing layer is reportable, not fatal: openusd records it as
        // unresolved and the scan still succeeds.
        assert_eq!(deps.entries.len(), 1, "entries: {:?}", deps.entries);
        let dep = &deps.entries[0];
        assert_eq!(dep.key, "missing.usda");
        assert!(!dep.node.resolved);
        assert!(dep.node.error_msg.is_some());
    }

    #[test]
    fn remote_fetch_leaves_local_entries_alone() {
        let port = spawn_http_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nusdbytes",
        );
        let dir = tempfile::tempdir().unwrap();
        let url = format!("http://127.0.0.1:{}/tex.png", port);
        write_usda(
            dir.path(),
            "root.usda",
            &format!(
                "#usda 1.0\ndef \"R\" (references = @./asset.usda@)\n{{\n    asset t = @{}@\n}}\n",
                url
            ),
        );
        write_usda(dir.path(), "asset.usda", "#usda 1.0\ndef \"A\"\n{\n}\n");

        let mut deps = scan(dir.path(), "root.usda");
        resolve_remote(&mut deps).unwrap();

        let local = deps
            .entries
            .iter()
            .find(|e| e.key == "asset.usda")
            .expect("local dep must stay in the scan");
        assert!(local.node.resolved);
        assert!(local.node.path.ends_with("asset.usda"));
        assert!(local.node.error_msg.is_none());
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
            &format!(
                "#usda 1.0\ndef \"R\"\n{{\n    asset t = @http://127.0.0.1:{}/tex.png@\n}}\n",
                port
            ),
        );

        let mut deps = scan(dir.path(), "root.usda");
        let result = resolve_remote(&mut deps);

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
            &format!("#usda 1.0\ndef \"R\"\n{{\n    asset t = @{}@\n}}\n", url),
        );

        let mut deps = scan(dir.path(), "root.usda");
        let dep = deps
            .entries
            .iter()
            .find(|e| e.key == url)
            .expect("remote dep is keyed by its original URL");
        assert!(!dep.node.resolved, "not fetched until resolve_remote runs");

        resolve_remote(&mut deps).unwrap();

        let dep = deps
            .entries
            .iter()
            .find(|e| e.key == url)
            .expect("remote dep is keyed by its original URL");
        assert!(
            dep.node.resolved,
            "fetched dep must resolve to the cache file"
        );
        assert_eq!(dep.node.size_bytes, Some(8));
        assert!(dep.node.error_msg.is_none());
        assert!(!dep.node.path.starts_with("http"), "path is the cache file");
    }

    // Regression for the original remote_fetch_failure flake: the download
    // cache persists across runs keyed by URL hash, and test URLs embed an
    // ephemeral port. A previous run that fetched the same port's URL left a
    // cache entry; a later run rebinding that port must still see the 404
    // fail instead of "succeeding" from the stale cache.
    #[test]
    fn stale_cache_entry_does_not_mask_a_failed_download() {
        let port = spawn_http_server(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let url = format!("http://127.0.0.1:{}/tex.png", port);

        let cache_dir = get_usdbee_cache_dir();
        let stale = cached_path_for(&url, &cache_dir);
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&stale, b"stale bytes from a previous run").unwrap();

        let dir = tempfile::tempdir().unwrap();
        write_usda(
            dir.path(),
            "root.usda",
            &format!("#usda 1.0\ndef \"R\"\n{{\n    asset t = @{url}@\n}}\n"),
        );

        let mut deps = scan(dir.path(), "root.usda");
        let result = resolve_remote(&mut deps);

        let err = result.expect_err("the evicted stale entry must not mask the 404");
        assert!(err.contains("Failed to download"), "got: {err}");
    }
}

