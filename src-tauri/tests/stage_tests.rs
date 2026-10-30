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
fn search_path_reference_resolves_only_via_resolver_roots() {
    // The referenced asset exists ONLY under the extracted-usdz resolver root,
    // under a name unique to this test process, so no anchor-dir or cwd
    // fallback can find it: removing the resolver search paths must fail here.
    let pin = format!("resolver_pin_{}", std::process::id());
    let pin_dir = usdbee_lib::get_usdbee_cache_dir()
        .join("extracted")
        .join(&pin);
    fs::create_dir_all(&pin_dir).expect("resolver root should be creatable");
    fs::write(
        pin_dir.join("asset.usda"),
        "#usda 1.0\n(\n    defaultPrim = \"Pinned\"\n)\n\ndef Xform \"Pinned\"\n{\n}\n",
    )
    .expect("pinned asset should be written");

    let dir = tempfile::tempdir().expect("temp dir should be created");
    let root = dir.path().join("search_pinned.usda");
    fs::write(
        &root,
        format!(
            "#usda 1.0\n\ndef Xform \"Scene\"\n{{\n    def \"Pinned\" (\n        references = @{}/asset.usda@\n    )\n    {{\n    }}\n}}\n",
            pin
        ),
    )
    .expect("test stage should be written");

    let (_stage, info) = open_stage(&root).expect("search-path stage should open");

    let _ = fs::remove_dir_all(&pin_dir);
    assert!(
        info.composition_errors.is_empty(),
        "search-path reference {}/asset.usda must resolve via the resolver search paths: {:?}",
        pin,
        info.composition_errors
    );
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
