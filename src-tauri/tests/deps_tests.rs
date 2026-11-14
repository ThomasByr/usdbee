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
    assert!(!scan.degraded, "a supported layer scans in full");
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
fn unsupported_layer_format_degrades_the_scan() {
    // F1: a scene whose composition tolerates an unreadable layer format
    // (MaterialX here) must open with a degraded scan, not a failed one.
    let scan = scan_dependencies(&fixture("mtlx_scene.usda"))
        .expect("an unsupported layer format must not fail the scan");

    assert!(scan.degraded, "the scan could not reach every layer");
    assert!(
        !scan.entries.iter().any(|e| e.key.ends_with(".mtlx")),
        "the unreadable layer is not a dependency: {:?}",
        scan.entries
    );
    // Accepted loss (R1): the degraded scan stops at the layer stack, so the
    // healthy root layer's own asset is missing too. This pins the limitation
    // so a future asset walk has to change it on purpose.
    assert!(
        !scan.entries.iter().any(|e| e.key.ends_with(".png")),
        "checker.png belongs to the healthy root layer and is not rediscovered: {:?}",
        scan.entries
    );
    for entry in &scan.entries {
        assert!(entry.node.resolved, "{}: {:?}", entry.key, entry.node);
        assert!(
            entry.node.error_msg.is_none(),
            "{}: {:?}",
            entry.key,
            entry.node
        );
    }
}

#[test]
fn degraded_scan_reports_the_layer_stack_only() {
    // R1: the degraded scan answers with the stage's layer stack and stops
    // there. Assets reached through the layers the unsupported format hid
    // are not discovered.
    let dir = tempfile::tempdir().unwrap();
    fs::copy(
        fixture("material_openpbr.mtlx"),
        dir.path().join("material_openpbr.mtlx"),
    )
    .unwrap();
    fs::write(dir.path().join("sub.usda"), "#usda 1.0\n").unwrap();
    let root = dir.path().join("scene.usda");
    fs::write(
        &root,
        "#usda 1.0\n(\n    subLayers = [@./sub.usda@]\n)\ndef \"W\"\n{\n    def Scope \"M\" (\n        prepend references = @./material_openpbr.mtlx@</MaterialX/Materials>\n    )\n    {\n    }\n}\n",
    )
    .unwrap();

    let scan = scan_dependencies(&root).expect("the scene opens with a degraded scan");

    assert!(scan.degraded);
    let keys: Vec<&str> = scan.entries.iter().map(|e| e.key.as_str()).collect();
    assert_eq!(keys, vec!["sub.usda"], "the layer stack and nothing else");
    assert!(scan.entries[0].node.resolved);
    assert!(scan.entries[0].node.error_msg.is_none());

    // The owner path must agree with the standalone scan on this same scene,
    // not only on the single-layer fixture (whose entry loops prove nothing).
    let owner = spawn_stage_owner();
    let info = owner.open(&root);
    let through_owner = owner
        .state
        .get_dependencies(info.stage_id)
        .expect("an open stage must still report its dependencies");
    let owner_keys: Vec<&str> = through_owner
        .entries
        .iter()
        .map(|e| e.key.as_str())
        .collect();
    assert!(through_owner.degraded, "the owner scan degrades too");
    assert_eq!(
        owner_keys, keys,
        "the owner scan reports a different layer stack"
    );
    assert_eq!(through_owner.root, scan.root);
    owner
        .state
        .close_stage(info.stage_id)
        .expect("the stage closes cleanly");
}

#[test]
fn owner_scan_of_mtlx_scene_is_degraded() {
    // The open path: the owner's scan must answer too, so the load survives.
    let owner = spawn_stage_owner();
    let info = owner.open(&fixture("mtlx_scene.usda"));
    // The user-facing notice rides the stage modal's composition errors.
    assert!(
        info.composition_errors
            .iter()
            .any(|e| e.contains("material_openpbr.mtlx")),
        "the failed layer must be named: {:?}",
        info.composition_errors
    );
    let scan = owner
        .state
        .get_dependencies(info.stage_id)
        .expect("an open stage must still report its dependencies");

    assert!(scan.degraded);
    // The session layer lives in the app cache and is bookkeeping, not a
    // scene dependency: every entry stays inside the scene's directory.
    let fixture_dir = fixture("mtlx_scene.usda");
    let fixture_dir = fixture_dir.parent().unwrap();
    for entry in &scan.entries {
        assert!(
            Path::new(&entry.node.path).starts_with(fixture_dir),
            "{} is not a scene dependency: {:?}",
            entry.key,
            entry.node
        );
        assert!(
            entry.node.error_msg.is_none(),
            "{}: {:?}",
            entry.key,
            entry.node
        );
    }
    assert!(
        !scan.entries.iter().any(|e| e.key.ends_with(".mtlx")),
        "entries: {:?}",
        scan.entries
    );
    owner
        .state
        .close_stage(info.stage_id)
        .expect("the stage closes cleanly");
}

#[test]
fn a_scan_error_that_is_not_an_unsupported_format_stays_fatal() {
    let err = match scan_dependencies(Path::new("no/such/scene.usda")) {
        Ok(_) => panic!("a root that cannot be read must fail the scan"),
        Err(e) => e,
    };
    assert!(
        err.contains("Failed to resolve"),
        "unexpected error shape: {}",
        err
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
        "xforms.usda",
        "mesh_primvars.usda",
        "material_scene.usda",
        "mtlx_scene.usda",
    ] {
        let scan = scan_dependencies(&fixture(name))
            .unwrap_or_else(|e| panic!("{} failed to scan: {}", name, e));
        assert!(scan.root.ends_with(name));
    }
}
