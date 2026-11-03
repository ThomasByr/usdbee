use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

pub fn get_usdbee_cache_dir() -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push("usdbee");
    dir.push("cache");
    dir
}

/// The hashed cache file a URL maps to. `pub(crate)` so tests can evict
/// stale entries from previous runs before exercising the download path.
pub(crate) fn cached_path_for(url: &str, cache_base_dir: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);

    let ext = Path::new(url.split('?').next().unwrap_or(url))
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("bin");

    cache_base_dir.join(format!("{:016x}.{}", hasher.finish(), ext))
}

pub fn fetch_and_cache_url(url: &str, cache_base_dir: &Path) -> Result<PathBuf, String> {
    let cached_path = cached_path_for(url, cache_base_dir);

    if cached_path.exists() {
        materialize_url_alias(url, cache_base_dir, &cached_path)?;
        return Ok(cached_path);
    }

    println!("Downloading USD remote dependency into cache: {}", url);
    let agent = ureq::AgentBuilder::new()
        .timeout(DOWNLOAD_TIMEOUT)
        .timeout_read(DOWNLOAD_TIMEOUT)
        .build();
    let response = agent
        .get(url)
        .call()
        .map_err(|e| format!("Failed to download {}: {}", url, e))?;

    let cached_path = cache_stream(response.into_reader(), &cached_path)?;
    materialize_url_alias(url, cache_base_dir, &cached_path)?;
    Ok(cached_path)
}

// DefaultResolver normalizes an authored URL to a relative `scheme:/...`
// path. A hard link at that spelling lets its cache-dir search path find the
// downloaded layer while the hashed cache name remains the canonical entry.
fn materialize_url_alias(
    url: &str,
    cache_base_dir: &Path,
    cached_path: &Path,
) -> Result<(), String> {
    let (scheme, rest) = url
        .split_once("://")
        .filter(|(scheme, _)| *scheme == "http" || *scheme == "https")
        .ok_or_else(|| format!("Cannot materialize non-HTTP URL in cache: {}", url))?;
    let mut relative = PathBuf::from(format!("{}:", scheme));
    for segment in rest.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains('\\') {
            return Err(format!("Remote URL has an unsafe cache path: {}", url));
        }
        relative.push(segment);
    }
    let alias = cache_base_dir.join(relative);
    if alias.exists() {
        return Ok(());
    }
    let parent = alias
        .parent()
        .ok_or_else(|| format!("Remote URL has no cache parent: {}", url))?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create remote cache path: {}", e))?;
    fs::hard_link(cached_path, &alias)
        .map_err(|e| format!("Failed to materialize remote cache path: {}", e))
}

// Writes the reader's bytes to `<final_path>.part`, then renames it onto
// `final_path`, so cache lookups only ever see fully-written files. Aborts
// past MAX_DOWNLOAD_BYTES and removes the `.part` file on any failure.
pub(crate) fn cache_stream(reader: impl Read, final_path: &Path) -> Result<PathBuf, String> {
    let mut name = final_path.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    let part_path = final_path.with_file_name(name);

    let result = (|| -> Result<PathBuf, String> {
        let mut part = fs::File::create(&part_path)
            .map_err(|e| format!("Failed to create cache file: {}", e))?;

        // take() is a backstop; the counted check below is what aborts.
        let mut limited = reader.take(MAX_DOWNLOAD_BYTES.saturating_add(1));
        let mut total: u64 = 0;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = limited
                .read(&mut buf)
                .map_err(|e| format!("Failed to read download stream: {}", e))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_DOWNLOAD_BYTES {
                return Err(format!(
                    "Download exceeds the maximum size of {} MiB.",
                    MAX_DOWNLOAD_BYTES / (1024 * 1024)
                ));
            }
            part.write_all(&buf[..n])
                .map_err(|e| format!("Failed to write cache file: {}", e))?;
        }

        fs::rename(&part_path, final_path)
            .map_err(|e| format!("Failed to finalize cache file: {}", e))?;

        Ok(final_path.to_path_buf())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&part_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    #[test]
    fn oversized_stream_aborts_and_leaves_no_cache_file() {
        let dir = tempfile::tempdir().unwrap();
        let final_path = dir.path().join("abc.bin");
        let oversized = std::io::repeat(0u8).take(MAX_DOWNLOAD_BYTES + 1);

        let result = cache_stream(oversized, &final_path);

        assert!(result.is_err(), "stream past the cap must abort");
        assert!(!final_path.exists(), "no final cache file may appear");
        assert!(
            !dir.path().join("abc.bin.part").exists(),
            "no .part file may be left behind"
        );
    }

    #[test]
    fn within_cap_stream_is_renamed_to_final_path() {
        let dir = tempfile::tempdir().unwrap();
        let final_path = dir.path().join("ok.bin");

        let result = cache_stream(Cursor::new(b"usd bytes".to_vec()), &final_path).unwrap();

        assert_eq!(result, final_path);
        assert!(final_path.exists());
        assert!(!dir.path().join("ok.bin.part").exists());
    }

    #[test]
    fn mid_stream_read_error_leaves_no_cache_files() {
        struct FlakyReader {
            sent: bool,
        }
        impl Read for FlakyReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if !self.sent {
                    self.sent = true;
                    buf[..3].copy_from_slice(b"abc");
                    Ok(3)
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionReset,
                        "connection reset mid-stream",
                    ))
                }
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let final_path = dir.path().join("flaky.bin");

        let result = cache_stream(FlakyReader { sent: false }, &final_path);

        assert!(result.is_err(), "a reader error mid-stream must abort");
        assert!(!final_path.exists(), "no final cache file may appear");
        assert!(
            !dir.path().join("flaky.bin.part").exists(),
            "no .part file may be left behind"
        );
    }
}
