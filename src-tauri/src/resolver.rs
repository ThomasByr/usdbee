use std::borrow::Cow;
use std::io;
use std::path::PathBuf;

use openusd::ar::{self, DefaultResolver};

use crate::fetcher::cached_path_for;
use crate::parser::remote_url;

/// Resolves local assets through the download cache and its `extracted/`
/// tree, and an `http(s)` identifier to its downloaded file.
///
/// `DefaultResolver` normalizes `http://host/p` to the relative path
/// `http:/host/p`, so serving a download through the search paths would need a
/// file whose name carries a colon — illegal on Windows. Answering the cache
/// file for the identifier keeps one spelling on every platform.
pub struct CacheResolver {
    inner: DefaultResolver,
    cache_dir: PathBuf,
}

impl CacheResolver {
    pub fn new(cache_dir: PathBuf) -> Self {
        let inner =
            DefaultResolver::with_search_paths([cache_dir.clone(), cache_dir.join("extracted")]);
        Self { inner, cache_dir }
    }

    /// The downloaded file an `http(s)` identifier names, when it is there.
    fn downloaded(&self, identifier: &str) -> Option<PathBuf> {
        let url = remote_url(identifier)?;
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return None;
        }
        // Canonicalized the way `DefaultResolver` spells its own identifiers,
        // so the same download reached by another spelling interns one layer.
        cached_path_for(&url, &self.cache_dir).canonicalize().ok()
    }
}

impl ar::Resolver for CacheResolver {
    fn create_identifier(&self, asset_path: &str, anchor: Option<&ar::ResolvedPath>) -> String {
        match self.downloaded(asset_path) {
            Some(path) => path.to_string_lossy().into_owned(),
            None => self.inner.create_identifier(asset_path, anchor),
        }
    }

    fn resolve(&self, asset_path: &str) -> Option<ar::ResolvedPath> {
        match self.downloaded(asset_path) {
            Some(path) => Some(ar::ResolvedPath::new(path)),
            None => self.inner.resolve(asset_path),
        }
    }

    fn resolve_for_new_asset(&self, asset_path: &str) -> Option<ar::ResolvedPath> {
        self.inner.resolve_for_new_asset(asset_path)
    }

    fn open_asset(&self, resolved_path: &ar::ResolvedPath) -> io::Result<Box<dyn ar::Asset>> {
        self.inner.open_asset(resolved_path)
    }

    fn is_context_dependent_path(&self, asset_path: &str) -> bool {
        self.inner.is_context_dependent_path(asset_path)
    }

    fn in_memory_identifier<'a>(&self, asset_path: &'a str) -> Cow<'a, str> {
        self.inner.in_memory_identifier(asset_path)
    }

    /// Two stages opened over different cache trees must not share a
    /// composition input.
    fn identity(&self) -> String {
        format!("usdbee-cache:{}", self.cache_dir.display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openusd::ar::Resolver;

    fn write_download(cache: &std::path::Path, url: &str) -> PathBuf {
        let path = cached_path_for(url, cache);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"downloaded").unwrap();
        path
    }

    #[test]
    fn an_http_identifier_resolves_to_its_downloaded_file() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path();
        let url = "http://example.test/tex.png";
        let file = write_download(cache, url).canonicalize().unwrap();
        let resolver = CacheResolver::new(cache.to_path_buf());

        assert_eq!(
            resolver.create_identifier(url, None),
            file.to_string_lossy()
        );
        assert_eq!(
            resolver.create_identifier("http:/example.test/tex.png", None),
            file.to_string_lossy()
        );
        let resolved = resolver.resolve(url).expect("download resolves");
        assert_eq!(&*resolved, file.as_path());
    }

    #[test]
    fn a_missing_download_keeps_the_plain_identifier() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path();
        let url = "http://example.test/absent.png";
        let resolver = CacheResolver::new(cache.to_path_buf());

        assert!(resolver.resolve(url).is_none());
        let identifier = resolver.create_identifier(url, None);
        assert_ne!(
            identifier,
            cached_path_for(url, cache).to_string_lossy().to_string()
        );
        assert!(identifier.contains("example.test"));
    }

    #[test]
    fn a_local_asset_still_resolves_through_the_cache_search_path() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path();
        let name = format!("local_{}.usda", std::process::id());
        let local = cache.join("sub").join(&name);
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::write(&local, b"#usda 1.0").unwrap();
        let local = local.canonicalize().unwrap();
        let resolver = CacheResolver::new(cache.to_path_buf());

        let resolved = resolver
            .resolve(&format!("sub/{}", name))
            .expect("search path resolves");
        assert!(resolved.ends_with(&local));
    }
}
