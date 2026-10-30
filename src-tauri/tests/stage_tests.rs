use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;

use usdbee_lib::stage::{open_stage, spawn_stage_owner, StageRequest};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

#[test]
fn opens_basic_stage_with_default_time_codes_per_second() {
    let (_stage, info) = open_stage(&fixture("basic.usda")).expect("basic stage should open");

    assert!(!info.root_layer.is_empty());
    assert_eq!(info.time_codes_per_second, 24.0);
    assert!(info.composition_errors.is_empty());
}

#[test]
fn opens_stage_with_resolved_reference() {
    let (_stage, info) =
        open_stage(&fixture("scene_with_ref.usda")).expect("referenced stage should open");

    assert!(info.composition_errors.is_empty());
}

#[test]
fn missing_reference_is_a_recoverable_composition_error() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let root = dir.path().join("missing_ref.usda");
    fs::write(
        &root,
        r#"#usda 1.0

def Xform "Scene"
{
    def "Broken" (
        references = @./missing.usda@
    )
    {
    }
}
"#,
    )
    .expect("test stage should be written");

    let (_stage, info) = open_stage(&root).expect("missing references must not fail stage open");

    assert!(!info.composition_errors.is_empty());
}

#[test]
fn copied_stage_resolves_reference_outside_fixture_layout() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let root = dir.path().join("scene_with_ref.usda");
    fs::copy(fixture("scene_with_ref.usda"), &root).expect("scene should be copied");
    fs::copy(fixture("asset.usda"), dir.path().join("asset.usda"))
        .expect("referenced asset should be copied");

    let (_stage, info) = open_stage(&root).expect("copied stage should open");

    assert!(info.composition_errors.is_empty());
}

#[test]
fn stage_owner_opens_stages_and_survives_open_errors() {
    let state = spawn_stage_owner();
    let (reply_tx, reply_rx) = mpsc::channel();
    state
        .sender
        .send(StageRequest::Open {
            path: fixture("basic.usda"),
            reply: reply_tx,
        })
        .expect("stage owner should accept an open request");

    let info = reply_rx
        .recv()
        .expect("stage owner should reply")
        .expect("stage owner should open the basic stage");
    assert!(!info.root_layer.is_empty());
    assert_eq!(info.time_codes_per_second, 24.0);
    assert!(info.composition_errors.is_empty());

    let (reply_tx, reply_rx) = mpsc::channel();
    state
        .sender
        .send(StageRequest::Open {
            path: fixture("does-not-exist.usda"),
            reply: reply_tx,
        })
        .expect("stage owner should still accept requests");

    let error = reply_rx
        .recv()
        .expect("stage owner should reply to the failed open")
        .expect_err("opening a nonexistent stage should fail");
    assert!(error.contains("does-not-exist.usda"));
}
