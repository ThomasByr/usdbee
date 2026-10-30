use std::fs;
use std::path::{Path, PathBuf};

use usdbee_lib::parser::scan_dependencies;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

#[test]
fn scan_finds_referenced_asset() {
    let scan = scan_dependencies(&fixture("scene_with_ref.usda")).unwrap();

    assert_eq!(scan.root, fixture("scene_with_ref.usda"));
    assert_eq!(scan.entries.len(), 1, "entries: {:?}", scan.entries);
    let dep = &scan.entries[0];
    assert_eq!(dep.key, "asset.usda");
    assert!(dep.node.resolved, "asset.usda sits next to the scene");
    assert!(dep.node.size_bytes.is_some());
    assert!(dep.node.error_msg.is_none());
}

#[test]
fn scan_of_self_contained_scene_returns_just_the_root() {
    let scan = scan_dependencies(&fixture("basic.usda")).unwrap();

    assert!(scan.root.ends_with("basic.usda"));
    assert!(
        scan.entries.is_empty(),
        "basic.usda names no other asset, got: {:?}",
        scan.entries
    );
}

#[test]
fn missing_reference_is_reported_without_panicking() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("scene_with_ref.usda");
    fs::copy(fixture("scene_with_ref.usda"), &root).unwrap();

    // No panic, no Err: a missing layer is a reportable, recoverable
    // outcome (Review Focus), not a load failure.
    let scan = scan_dependencies(&root).unwrap();

    let dep = scan
        .entries
        .iter()
        .find(|e| e.key == "asset.usda")
        .expect("missing layer must be reported in the scan");
    assert!(!dep.node.resolved);
    assert!(dep.node.error_msg.is_some());
    assert!(dep.node.size_bytes.is_none());
}

#[test]
fn scan_follows_payload_arcs() {
    let scan = scan_dependencies(&fixture("payload.usda")).unwrap();

    assert!(
        scan.entries
            .iter()
            .any(|e| e.key == "asset.usda" && e.node.resolved),
        "payload arcs are dependencies too, got: {:?}",
        scan.entries
    );
}

#[test]
fn every_fixture_scans_without_error() {
    // The fixtures are the shared corpus for Phases 1-3; this pins that
    // each parses and scans cleanly as authored.
    for name in [
        "basic.usda",
        "asset.usda",
        "scene_with_ref.usda",
        "variants.usda",
        "instanced.usda",
        "animated.usda",
        "payload.usda",
    ] {
        let scan = scan_dependencies(&fixture(name))
            .unwrap_or_else(|e| panic!("{} failed to scan: {}", name, e));
        assert!(scan.root.ends_with(name));
    }
}
