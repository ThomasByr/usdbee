use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;

use usdbee_lib::stage::{
    open_stage, request_stage_tree, spawn_stage_owner, PrimNode, StageRequest, StageState,
};

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

fn open_via_owner(state: &StageState, name: &str) {
    let (reply_tx, reply_rx) = mpsc::channel();
    state
        .sender
        .send(StageRequest::Open {
            path: fixture(name),
            reply: reply_tx,
        })
        .expect("stage owner should accept an open request");
    reply_rx
        .recv()
        .expect("stage owner should reply")
        .expect("stage should open");
}

fn tree_via_owner(state: &StageState) -> Vec<PrimNode> {
    request_stage_tree(&state.sender).expect("tree should serialize")
}

fn node<'a>(nodes: &'a [PrimNode], path: &str) -> &'a PrimNode {
    nodes
        .iter()
        .find(|n| n.path == path)
        .unwrap_or_else(|| panic!("expected prim {} in tree {:?}", path, nodes))
}

#[test]
fn basic_tree_matches_authored_hierarchy() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");
    let tree = tree_via_owner(&state);

    assert_eq!(tree.len(), 1, "pseudo-root has one child: {:?}", tree);
    let world = &tree[0];
    assert_eq!(world.path, "/World");
    assert_eq!(world.name, "World");
    assert_eq!(world.type_name, "Xform");
    assert_eq!(world.kind, "");
    assert!(world.is_active);
    assert!(!world.is_instance);
    assert!(!world.is_abstract);

    assert_eq!(world.children.len(), 2);
    let ground = node(&world.children, "/World/Ground");
    assert_eq!(ground.type_name, "Xform");
    assert!(ground.is_active);
    assert!(ground.children.is_empty());

    let ball = node(&world.children, "/World/Ball");
    assert_eq!(ball.type_name, "Mesh");
    assert!(ball.is_active);
    assert!(ball.children.is_empty());
}

#[test]
fn variants_tree_reflects_selected_variant_children() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "variants.usda");
    let tree = tree_via_owner(&state);

    assert_eq!(tree.len(), 1);
    let prop = &tree[0];
    assert_eq!(prop.path, "/Prop");
    assert_eq!(prop.type_name, "Xform");
    assert_eq!(prop.children.len(), 1, "only the selected variant composes");
    let shape = &prop.children[0];
    assert_eq!(shape.path, "/Prop/Shape");
    assert_eq!(shape.type_name, "Sphere");
    assert!(shape.children.is_empty());
}

#[test]
fn instanced_tree_lists_instances_without_children() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "instanced.usda");
    let tree = tree_via_owner(&state);

    assert_eq!(tree.len(), 1);
    let scene = &tree[0];
    assert_eq!(scene.path, "/Scene");
    assert_eq!(scene.children.len(), 2);
    for wheel in &scene.children {
        assert!(wheel.is_instance, "{} must be an instance", wheel.path);
        assert_eq!(wheel.type_name, "Xform");
        assert!(wheel.children.is_empty(), "instances must not expand");
    }
    assert_eq!(scene.children[0].path, "/Scene/WheelA");
    assert_eq!(scene.children[1].path, "/Scene/WheelB");
}

#[test]
fn referenced_children_appear_under_referencing_prim() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "scene_with_ref.usda");
    let tree = tree_via_owner(&state);

    assert_eq!(tree.len(), 1);
    let car = node(&tree[0].children, "/Scene/Car");
    assert_eq!(car.type_name, "Xform");
    assert_eq!(car.children.len(), 1);
    let wheel = &car.children[0];
    assert_eq!(wheel.path, "/Scene/Car/Wheel");
    assert_eq!(wheel.type_name, "Sphere");
}

#[test]
fn reopening_a_stage_replaces_the_tree_completely() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");
    let first = tree_via_owner(&state);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].path, "/World");

    open_via_owner(&state, "variants.usda");
    let second = tree_via_owner(&state);
    assert_eq!(second.len(), 1, "no stale nodes from the previous stage");
    assert_eq!(second[0].path, "/Prop");
}

#[test]
fn tree_request_without_open_stage_fails() {
    let state = spawn_stage_owner();
    let error = request_stage_tree(&state.sender).expect_err("no stage is open");
    assert!(error.contains("no stage open"), "got: {}", error);
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
