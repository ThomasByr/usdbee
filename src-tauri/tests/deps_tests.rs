use std::fs;
use std::path::{Path, PathBuf};

mod common;

use common::spawn_stage_owner;
use usdbee_lib::parser::{scan_dependencies, DependencyScan};

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
fn stage_scan_matches_the_standalone_scan() {
    // The owner computes the scan against the layers its open already
    // parsed, so it must report exactly what the standalone scan (which
    // opens its own stage) reports for the same file — text, binary and
    // packaged alike.
    let dir = tempfile::tempdir().unwrap();
    let source = fixture("scene_with_ref.usda");
    let layer = openusd::sdf::Layer::open(source.to_str().unwrap()).expect("fixture layer opens");
    fs::copy(fixture("asset.usda"), dir.path().join("asset.usda")).unwrap();
    let owner = spawn_stage_owner();

    /// The scan in its comparable form: (key, every node field) per entry, sorted.
    fn serialized_entries(scan: &DependencyScan) -> Vec<(String, String)> {
        let mut entries: Vec<(String, String)> = scan
            .entries
            .iter()
            .map(|entry| {
                (
                    entry.key.clone(),
                    serde_json::to_string(&entry.node).expect("dependency node serializes"),
                )
            })
            .collect();
        entries.sort();
        entries
    }

    for extension in ["usdc", "usdz"] {
        let path = dir.path().join(format!("scene_with_ref.{}", extension));
        layer
            .export(path.to_str().unwrap())
            .expect("generated stage is written");

        let standalone = scan_dependencies(&path).unwrap();
        let info = owner.open(&path);
        let through_owner = owner
            .state
            .get_dependencies(info.stage_id)
            .expect("an open stage must report its dependencies");
        owner
            .state
            .close_stage(info.stage_id)
            .expect("the stage closes cleanly");

        assert!(
            !through_owner.entries.is_empty(),
            "{}: the fixture must reach a dependency for this comparison to mean anything",
            extension
        );
        assert_eq!(
            serialized_entries(&through_owner),
            serialized_entries(&standalone),
            "{} scan differs from the standalone scan",
            extension
        );
        assert_eq!(through_owner.root, standalone.root);
    }
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
        "xforms.usda",
        "mesh_primvars.usda",
        "material_scene.usda",
    ] {
        let scan = scan_dependencies(&fixture(name))
            .unwrap_or_else(|e| panic!("{} failed to scan: {}", name, e));
        assert!(scan.root.ends_with(name));
    }
}
