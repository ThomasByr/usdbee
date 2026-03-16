use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

pub fn get_usdbee_cache_dir() -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push("usdbee");
    dir.push("cache");
    dir
}

pub fn fetch_and_cache_url(url: &str, cache_base_dir: &Path) -> Result<PathBuf, String> {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    let hash = hasher.finish();

    let ext = Path::new(url.split('?').next().unwrap_or(url))
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("bin");

    let safe_name = format!("{:016x}.{}", hash, ext);
    let cached_path = cache_base_dir.join(&safe_name);

    if cached_path.exists() {
        return Ok(cached_path);
    }

    println!("Downloading USD remote dependency into cache: {}", url);
    let response = ureq::get(url)
        .call()
        .map_err(|e| format!("Failed to download {}: {}", url, e))?;

    let mut reader = response.into_reader();
    let mut temp_file = fs::File::create(&cached_path)
        .map_err(|e| format!("Failed to create cache file: {}", e))?;

    std::io::copy(&mut reader, &mut temp_file)
        .map_err(|e| format!("Failed to write cache file: {}", e))?;

    Ok(cached_path)
}
