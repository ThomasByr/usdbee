mod common;

use usdbee_lib::stage::{request_list_dirty_layers, request_set_edit_target, request_stage_tree};

use common::{
    details_via_owner, fixture, open_path_via_owner, open_via_owner, owner_with_events, payload,
    request_set_value, request_set_variant_selection, spawn_stage_owner, variant_set,
};

fn tree_node<'a>(
    nodes: &'a [usdbee_lib::stage::PrimNode],
    path: &str,
) -> &'a usdbee_lib::stage::PrimNode {
    nodes
        .iter()
        .find(|n| n.path == path)
        .unwrap_or_else(|| panic!("expected node {} in {:?}", path, nodes))
}

#[test]
fn variant_selection_authors_on_the_session_layer_and_composes() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "variants.usda");

    // Selecting blue authors on the session layer (the default target) and
    // reads back as the composed selection (stronger than the root's red).
    request_set_variant_selection(&state, "/Prop", "color", Some("blue"))
        .expect("selecting a variant should succeed");
    let details = details_via_owner(&state, "/Prop", None);
    assert_eq!(
        variant_set(&details, "color").authored_selection.as_deref(),
        Some("blue")
    );

    // A variant with a distinct child shows in the composed tree.
    request_set_variant_selection(&state, "/Prop", "color", Some("green"))
        .expect("switching variants should succeed");
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    assert!(
        tree[0]
            .children
            .iter()
            .any(|c| c.path == "/Prop/GreenShape"),
        "the green variant's child composes: {:?}",
        tree[0].children
    );

    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("usd-stage-changed should fire after the selection edit");
    assert_eq!(paths, vec!["/Prop".to_string()]);

    // Clearing removes the session opinion; the root layer's authored
    // `color = "red"` composes again.
    request_set_variant_selection(&state, "/Prop", "color", None)
        .expect("clearing the selection should succeed");
    let details = details_via_owner(&state, "/Prop", None);
    assert_eq!(
        variant_set(&details, "color").authored_selection.as_deref(),
        Some("red")
    );
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    assert!(
        !tree[0]
            .children
            .iter()
            .any(|c| c.path == "/Prop/GreenShape"),
        "the cleared variant's child is gone: {:?}",
        tree[0].children
    );
    assert!(tree[0].children.iter().any(|c| c.path == "/Prop/Shape"));

    // Every edit above targeted the session layer: it is the only dirty one.
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(
        dirty.len(),
        1,
        "only the session layer is dirty: {:?}",
        dirty
    );
    assert!(dirty[0].is_session);
}

#[test]
fn variant_selection_on_an_instance_prim_is_a_readable_error() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "instanced.usda");

    // The instance root: same guard family as value/metadata edits.
    let error = request_set_variant_selection(&state, "/Scene/WheelA", "color", Some("blue"))
        .expect_err("variant edits on an instance prim must fail");
    assert!(
        error.contains("/__Prototype_0"),
        "the error must name the prototype, got: {}",
        error
    );
    assert!(error.contains("instance"), "got: {}", error);

    // A prim inside the instance (an instance proxy).
    let error = request_set_variant_selection(&state, "/Scene/WheelA/Wheel", "color", Some("blue"))
        .expect_err("variant edits inside an instance must fail");
    assert!(
        error.contains("/__Prototype_0/Wheel"),
        "the error must name the prototype-side prim, got: {}",
        error
    );
}

#[test]
fn variant_selection_on_a_referenced_layer_dirties_that_layer() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("scene_with_ref.usda"));

    // Switch the edit target to the referenced asset's layer.
    let asset_id = fixture("asset.usda").to_string_lossy().to_string();
    request_set_edit_target(&state.sender(), Some(&asset_id))
        .expect("switching to the referenced layer should succeed");

    request_set_variant_selection(&state, "/Scene/Car", "trim", Some("sport"))
        .expect("variant selection on the referenced layer should succeed");

    // The referenced layer is dirty — never the referencing root.
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(
        dirty.len(),
        1,
        "only the referenced layer is dirty: {:?}",
        dirty
    );
    assert!(!dirty[0].is_session);
    assert_eq!(dirty[0].identifier, asset_id);
    assert_ne!(dirty[0].identifier, info.root_layer);

    // The selection composed through the reference: the sport variant's
    // child appears under the referencing prim.
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    let car = tree_node(&tree[0].children, "/Scene/Car");
    assert!(
        car.children.iter().any(|c| c.path == "/Scene/Car/Spoiler"),
        "the sport variant's child composes: {:?}",
        car.children
    );

    let details = details_via_owner(&state, "/Scene/Car", None);
    assert_eq!(
        variant_set(&details, "trim").authored_selection.as_deref(),
        Some("sport")
    );

    // The tree reverts when the selection is cleared: the asset's authored
    // `trim = "base"` composes again.
    request_set_variant_selection(&state, "/Scene/Car", "trim", None)
        .expect("clearing the referenced-layer selection should succeed");
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    let car = tree_node(&tree[0].children, "/Scene/Car");
    assert!(
        !car.children.iter().any(|c| c.path == "/Scene/Car/Spoiler"),
        "the cleared variant's child is gone: {:?}",
        car.children
    );
}

#[test]
fn set_metadata_active_false_deactivates_prim() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender(),
        "/World/Ball",
        "active",
        &payload("bool", serde_json::json!(false)),
    )
    .expect("deactivating a prim should succeed");

    // The tree keeps the prim (Phase 1 semantics: inactive prims stay listed)
    // but flags it inactive.
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    let world = &tree[0];
    let ball = world
        .children
        .iter()
        .find(|n| n.path == "/World/Ball")
        .expect("inactive prim stays in the tree");
    assert!(!ball.is_active);

    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("usd-stage-changed should fire after the metadata edit");
    assert_eq!(paths, vec!["/World/Ball".to_string()]);

    // Editing an inactive prim is rejected with readable context.
    let error = request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(1.0)),
        None,
    )
    .expect_err("editing an inactive prim must fail");
    assert!(
        error.contains("inactive"),
        "the error must name the inactive state, got: {}",
        error
    );
}

#[test]
fn set_metadata_kind_authors_kind_token() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender(),
        "/World/Ball",
        "kind",
        &payload("token", serde_json::json!("prop")),
    )
    .expect("setting kind should succeed");

    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(details.kind, "prop");
}

#[test]
fn edits_fail_soft_with_readable_errors() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    // Missing prim.
    let error = request_set_value(
        &state,
        "/World/Nope",
        "radius",
        payload("float", serde_json::json!(1.0)),
        None,
    )
    .expect_err("editing a missing prim must fail");
    assert!(error.contains("prim not found"), "got: {}", error);

    // Not-yet-editable value family (arrays).
    let error = request_set_value(
        &state,
        "/World/Ball",
        "faceVertexCounts",
        payload("int_array", serde_json::json!([3])),
        None,
    )
    .expect_err("array edits must fail with a readable message");
    assert!(error.contains("not editable"), "got: {}", error);

    // Metadata key outside the supported set.
    let error = usdbee_lib::stage::request_set_prim_metadata(
        &state.sender(),
        "/World/Ball",
        "apiSchemas",
        &payload("token", serde_json::json!("FooAPI")),
    )
    .expect_err("unsupported metadata keys must fail");
    assert!(error.contains("not editable"), "got: {}", error);

    // The owner survives all failures.
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(details.type_name, "Mesh");
}

#[test]
fn edits_without_open_stage_fail() {
    // No stage open means the tracked id is 0 — every command shape
    // routes through the same readable id guard.
    let state = spawn_stage_owner();
    let error = state.state.sender(0).expect_err("no stage is open");
    assert!(error.contains("no stage 0"), "got: {}", error);
    let error = state.state.close_stage(0).expect_err("no stage is open");
    assert!(error.contains("no stage 0"), "got: {}", error);
}

#[test]
fn set_metadata_active_true_reactivates_an_inactive_prim() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender(),
        "/World/Ball",
        "active",
        &payload("bool", serde_json::json!(false)),
    )
    .expect("deactivating a prim should succeed");

    // Reactivation is the ONE mutation allowed on an inactive prim.
    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender(),
        "/World/Ball",
        "active",
        &payload("bool", serde_json::json!(true)),
    )
    .expect("reactivating via active=true metadata should succeed");

    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    let world = &tree[0];
    let ball = world
        .children
        .iter()
        .find(|n| n.path == "/World/Ball")
        .expect("the prim stays in the tree");
    assert!(ball.is_active, "the prim is active again");

    // Every other mutation on a re-deactivated prim is still rejected.
    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender(),
        "/World/Ball",
        "active",
        &payload("bool", serde_json::json!(false)),
    )
    .expect("deactivate again");
    let error = usdbee_lib::stage::request_set_prim_metadata(
        &state.sender(),
        "/World/Ball",
        "kind",
        &payload("token", serde_json::json!("prop")),
    )
    .expect_err("non-reactivation metadata on an inactive prim must fail");
    assert!(error.contains("inactive"), "got: {}", error);
}
