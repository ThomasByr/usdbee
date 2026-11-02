use std::path::{Path, PathBuf};
use std::sync::mpsc;

use usdbee_lib::stage::{
    request_edit_target, request_geometry_data, request_list_dirty_layers, request_save_layers,
    request_set_edit_target, request_stage_details, request_stage_open, request_stage_tree,
    spawn_stage_owner_with_sink, EditTargetInfo, LayerSaveRequest, StageState,
};
use usdbee_lib::values::PrimDetails;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// An owner plus a channel capturing every `usd-stage-changed` emission.
fn owner_with_events() -> (StageState, mpsc::Receiver<Vec<String>>) {
    let (event_tx, event_rx) = mpsc::channel();
    let state = spawn_stage_owner_with_sink(Some(Box::new(move |paths: &[String]| {
        let _ = event_tx.send(paths.to_vec());
    })));
    (state, event_rx)
}

fn open_path_via_owner(state: &StageState, path: &Path) -> usdbee_lib::stage::StageInfo {
    request_stage_open(path, false, &state.sender).expect("stage should open")
}

fn open_via_owner(state: &StageState, name: &str) {
    let _ = open_path_via_owner(state, &fixture(name));
}

fn details_via_owner(state: &StageState, path: &str, time: Option<f64>) -> PrimDetails {
    request_stage_details(&state.sender, path, time).expect("details should serialize")
}

fn attribute<'a>(details: &'a PrimDetails, name: &str) -> &'a usdbee_lib::values::AttributeInfo {
    details
        .attributes
        .iter()
        .find(|a| a.name == name)
        .unwrap_or_else(|| panic!("expected attribute {} in {:?}", name, details.attributes))
}

fn request_set_value(
    state: &StageState,
    path: &str,
    name: &str,
    value: usdbee_lib::values::ValuePayload,
    time: Option<f64>,
) -> Result<(), String> {
    usdbee_lib::stage::request_set_attribute_value(&state.sender, path, name, &value, time)
}

fn payload(r#type: &str, data: serde_json::Value) -> usdbee_lib::values::ValuePayload {
    usdbee_lib::values::ValuePayload {
        r#type: r#type.to_string(),
        data,
        truncated: None,
        count: None,
    }
}

#[test]
fn set_value_authors_composed_value_on_session_layer() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("setting an authored float should succeed");

    let details = details_via_owner(&state, "/World/Ball", None);
    let radius = attribute(&details, "radius");
    assert!(radius.authored);
    assert_eq!(radius.value.r#type, "float");
    assert_eq!(radius.value.data, serde_json::json!(2.5));

    // The edit landed on the session layer, never the root layer.
    let dirty = request_list_dirty_layers(&state.sender).expect("dirty layers list");
    assert_eq!(
        dirty.len(),
        1,
        "the edit marks exactly the session layer dirty"
    );
    assert!(dirty[0].is_session, "the session layer entry is flagged");
    assert!(
        dirty[0].identifier.contains("session"),
        "dirty layer should be the session layer, got {}",
        dirty[0].identifier
    );

    // The actor emitted usd-stage-changed with the edited prim path.
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("usd-stage-changed should fire after the edit");
    assert_eq!(paths, vec!["/World/Ball".to_string()]);
}

#[test]
fn set_value_authors_unauthored_and_undeclared_attributes() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    // `declaredOnly` is declared (float) but carries no authored value: the
    // edit must stamp a spec with the declared type and author the value.
    request_set_value(
        &state,
        "/World/Ball",
        "declaredOnly",
        payload("float", serde_json::json!(4.5)),
        None,
    )
    .expect("setting a declared-but-unauthored attribute should succeed");

    let details = details_via_owner(&state, "/World/Ball", None);
    let declared = attribute(&details, "declaredOnly");
    assert!(declared.authored);
    assert_eq!(declared.type_name, "float");
    assert_eq!(declared.value.data, serde_json::json!(4.5));

    // A name nothing declares is created with the payload's type.
    request_set_value(
        &state,
        "/World/Ball",
        "freshAttr",
        payload("double", serde_json::json!(-1.25)),
        None,
    )
    .expect("creating a new attribute should succeed");
    let details = details_via_owner(&state, "/World/Ball", None);
    let fresh = attribute(&details, "freshAttr");
    assert!(fresh.authored);
    assert_eq!(fresh.type_name, "double");
    assert_eq!(fresh.value.data, serde_json::json!(-1.25));
}

#[test]
fn set_value_on_instance_prim_is_a_readable_error() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "instanced.usda");

    let error = request_set_value(
        &state,
        "/Scene/WheelA",
        "visibility",
        payload("token", serde_json::json!("inherited")),
        None,
    )
    .expect_err("editing an instance prim must fail");
    assert!(
        error.contains("/__Prototype_0"),
        "the error must name the prototype, got: {}",
        error
    );
    assert!(
        error.contains("instance"),
        "the error must explain the instance rule, got: {}",
        error
    );

    // A prim INSIDE the instance is an instance proxy: same guard family,
    // and the error names the prototype-side prim to edit instead.
    let error = request_set_value(
        &state,
        "/Scene/WheelA/Wheel",
        "radius",
        payload("double", serde_json::json!(1.0)),
        None,
    )
    .expect_err("editing inside an instance must fail");
    assert!(
        error.contains("/__Prototype_0/Wheel"),
        "the error must name the prototype-side prim, got: {}",
        error
    );
    assert!(
        error.contains("instance"),
        "the error must explain the instance rule, got: {}",
        error
    );
}

// --- Task 3: variant selection ---

fn request_set_variant_selection(
    state: &StageState,
    path: &str,
    variant_set: &str,
    selection: Option<&str>,
) -> Result<(), String> {
    usdbee_lib::stage::request_set_variant_selection(&state.sender, path, variant_set, selection)
}

fn variant_set<'a>(details: &'a PrimDetails, name: &str) -> &'a usdbee_lib::values::VariantSetInfo {
    details
        .variant_sets
        .iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| {
            panic!(
                "expected variant set {} in {:?}",
                name, details.variant_sets
            )
        })
}

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
    let tree = request_stage_tree(&state.sender).expect("tree should serialize");
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
    let tree = request_stage_tree(&state.sender).expect("tree should serialize");
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
    let dirty = request_list_dirty_layers(&state.sender).expect("dirty layers list");
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
    request_set_edit_target(&state.sender, Some(&asset_id))
        .expect("switching to the referenced layer should succeed");

    request_set_variant_selection(&state, "/Scene/Car", "trim", Some("sport"))
        .expect("variant selection on the referenced layer should succeed");

    // The referenced layer is dirty — never the referencing root.
    let dirty = request_list_dirty_layers(&state.sender).expect("dirty layers list");
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
    let tree = request_stage_tree(&state.sender).expect("tree should serialize");
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
    let tree = request_stage_tree(&state.sender).expect("tree should serialize");
    let car = tree_node(&tree[0].children, "/Scene/Car");
    assert!(
        !car.children.iter().any(|c| c.path == "/Scene/Car/Spoiler"),
        "the cleared variant's child is gone: {:?}",
        car.children
    );
}

#[test]
fn set_value_time_sample_reads_back_and_clears_caches() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "animated.usda");

    // Prime the tessellation cache with one geometry fetch (Still authors
    // default-time points; Wobble's are sampled, so default time has none).
    request_geometry_data(&state.sender, "/Scene/Still", None).expect("geometry fetches");
    let before = state.mesh_tessellations();
    assert_eq!(before, 1);

    // `size` has samples at 1 and 24; authoring at frame 10 must read back
    // exactly 3.0 at frame 10 (time codes are frames, not seconds).
    request_set_value(
        &state,
        "/Scene/Pulse",
        "size",
        payload("double", serde_json::json!(3.0)),
        Some(10.0),
    )
    .expect("authoring a time sample should succeed");

    let details = details_via_owner(&state, "/Scene/Pulse", Some(10.0));
    let size = attribute(&details, "size");
    assert_eq!(size.value.data, serde_json::json!(3.0));

    // The mutation cleared the mesh cache: the same fetch re-tessellates.
    request_geometry_data(&state.sender, "/Scene/Still", None).expect("geometry refetches");
    assert_eq!(state.mesh_tessellations(), before + 1);
}

#[test]
fn set_metadata_active_false_deactivates_prim() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender,
        "/World/Ball",
        "active",
        &payload("bool", serde_json::json!(false)),
    )
    .expect("deactivating a prim should succeed");

    // The tree keeps the prim (Phase 1 semantics: inactive prims stay listed)
    // but flags it inactive.
    let tree = request_stage_tree(&state.sender).expect("tree should serialize");
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
        &state.sender,
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
        &state.sender,
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
    let state = spawn_stage_owner_with_sink(None);
    let error = request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect_err("no stage is open");
    assert!(error.contains("no stage open"), "got: {}", error);

    let error = usdbee_lib::stage::request_set_prim_metadata(
        &state.sender,
        "/World/Ball",
        "active",
        &payload("bool", serde_json::json!(false)),
    )
    .expect_err("no stage is open");
    assert!(error.contains("no stage open"), "got: {}", error);
}

// --- Task 2: edit targets, dirty layers, save ---

fn edit_target(state: &StageState) -> EditTargetInfo {
    request_edit_target(&state.sender).expect("edit target should serialize")
}

#[test]
fn edit_target_defaults_to_session_and_switches_to_root() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    // The default target is the session layer (set at open time).
    let target = edit_target(&state);
    assert!(target.is_session);
    assert!(!target.is_usdz_stage);
    assert!(target.layer_identifier.contains("session"));

    // A session edit dirties the session layer only.
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("session edit should succeed");

    // Switch to the root layer and edit there.
    request_set_edit_target(&state.sender, Some(&info.root_layer))
        .expect("switching to the root layer should succeed");
    let target = edit_target(&state);
    assert!(!target.is_session);
    assert_eq!(target.layer_identifier, info.root_layer);

    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(3.5)),
        None,
    )
    .expect("root edit should succeed");

    // Both layers are dirty now, each listed with its own identity.
    let dirty = request_list_dirty_layers(&state.sender).expect("dirty layers list");
    assert_eq!(
        dirty.len(),
        2,
        "session and root are both dirty: {:?}",
        dirty
    );
    let session = dirty.iter().find(|l| l.is_session).expect("session entry");
    let root = dirty.iter().find(|l| !l.is_session).expect("root entry");
    assert_eq!(root.identifier, info.root_layer);
    assert_eq!(
        root.original_path.as_deref(),
        Some(info.root_layer.as_str())
    );
    assert!(session.identifier.contains("session"));
}

#[test]
fn set_edit_target_rejects_unknown_layers_and_missing_session() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    let error = request_set_edit_target(&state.sender, Some("/nope/missing.usda"))
        .expect_err("an unknown layer must be rejected");
    assert!(error.contains("missing.usda"), "got: {}", error);

    // None means the session layer, which exists here: it must succeed.
    request_set_edit_target(&state.sender, None).expect("None selects the session layer");
}

#[test]
fn set_edit_target_without_open_stage_fails() {
    let state = spawn_stage_owner_with_sink(None);
    let error = request_set_edit_target(&state.sender, None).expect_err("no stage is open");
    assert!(error.contains("no stage open"), "got: {}", error);
    let error = request_list_dirty_layers(&state.sender).expect_err("no stage is open");
    assert!(error.contains("no stage open"), "got: {}", error);
}

#[test]
fn save_layers_writes_the_authored_opinion_and_clears_the_layer() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    // A session edit first: the session layer must stay dirty and its file
    // untouched after the root layer below is saved.
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(1.5)),
        None,
    )
    .expect("session edit should succeed");

    request_set_edit_target(&state.sender, Some(&info.root_layer)).expect("switch to root");
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("root edit should succeed");

    let dir = tempfile::tempdir().expect("temp dir");
    let saved = dir.path().join("saved.usda");
    request_save_layers(
        &state.sender,
        &[LayerSaveRequest {
            identifier: info.root_layer.clone(),
            path: saved.to_string_lossy().to_string(),
        }],
    )
    .expect("saving the root layer should succeed");

    // The file on disk contains the authored opinion...
    let text = std::fs::read_to_string(&saved).expect("saved file reads");
    assert!(
        text.contains("radius = 2.5"),
        "authored opinion in:\n{}",
        text
    );

    // ...the session layer file is untouched, and the root layer is clean.
    let dirty = request_list_dirty_layers(&state.sender).expect("dirty layers list");
    assert!(
        dirty.iter().all(|l| l.is_session),
        "only the session layer stays dirty: {:?}",
        dirty
    );
    let session = dirty.iter().find(|l| l.is_session).expect("session entry");
    let session_text = std::fs::read_to_string(
        session
            .original_path
            .as_deref()
            .expect("the session layer is a real file"),
    )
    .expect("session file reads");
    assert!(
        !session_text.contains("radius"),
        "the session layer file must stay untouched"
    );
}

#[test]
fn save_layers_rejects_session_over_existing_layer_paths() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("session edit should succeed");
    let dirty = request_list_dirty_layers(&state.sender).expect("dirty layers list");
    let session = dirty.iter().find(|l| l.is_session).expect("session entry");

    // Same-as-root path: refused (it would overwrite the root layer file).
    let error = request_save_layers(
        &state.sender,
        &[LayerSaveRequest {
            identifier: session.identifier.clone(),
            path: info.root_layer.clone(),
        }],
    )
    .expect_err("saving the session layer over the root file must fail");
    assert!(error.contains("session"), "got: {}", error);
    assert!(
        error.contains("basic.usda"),
        "the error names the colliding file: {}",
        error
    );

    // The session layer's own temp path is equally refused.
    let own = session.original_path.clone().expect("session file path");
    let error = request_save_layers(
        &state.sender,
        &[LayerSaveRequest {
            identifier: session.identifier.clone(),
            path: own,
        }],
    )
    .expect_err("saving the session layer over its own file must fail");
    assert!(error.contains("session"), "got: {}", error);

    // A new usda path is the only allowed spelling.
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("session-snapshot.usda");
    request_save_layers(
        &state.sender,
        &[LayerSaveRequest {
            identifier: session.identifier.clone(),
            path: path.to_string_lossy().to_string(),
        }],
    )
    .expect("saving the session layer to a new usda path should succeed");
    let dirty = request_list_dirty_layers(&state.sender).expect("dirty layers list");
    assert!(
        dirty.is_empty(),
        "the session layer is clean after save: {:?}",
        dirty
    );
}

#[test]
fn save_layers_enforces_the_extension_whitelist() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    request_set_edit_target(&state.sender, Some(&info.root_layer)).expect("switch to root");
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("root edit should succeed");

    let error = request_save_layers(
        &state.sender,
        &[LayerSaveRequest {
            identifier: info.root_layer.clone(),
            path: "/tmp/sneaky.exe".to_string(),
        }],
    )
    .expect_err("exe must be refused");
    assert!(
        error.contains(".usda"),
        "the error lists the whitelist: {}",
        error
    );
    assert!(error.contains("exe"), "got: {}", error);

    // usdc and usd stay writable (whitelist members).
    let dir = tempfile::tempdir().expect("temp dir");
    for name in ["out.usdc", "out.usd"] {
        request_save_layers(
            &state.sender,
            &[LayerSaveRequest {
                identifier: info.root_layer.clone(),
                path: dir.path().join(name).to_string_lossy().to_string(),
            }],
        )
        .unwrap_or_else(|e| panic!("{} should be writable: {}", name, e));
    }
}

#[test]
fn sublayer_dirties_and_lists_independently() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "sublayer_root.usda");

    let sub_identifier = fixture("sublayer_sub.usda");
    let sub_identifier = sub_identifier.to_string_lossy().to_string();
    request_set_edit_target(&state.sender, Some(&sub_identifier))
        .expect("switching to the sublayer should succeed");

    request_set_value(
        &state,
        "/Scene/Sub",
        "radius",
        payload("double", serde_json::json!(1.5)),
        None,
    )
    .expect("sublayer edit should succeed");

    let dirty = request_list_dirty_layers(&state.sender).expect("dirty layers list");
    assert_eq!(dirty.len(), 1, "only the sublayer is dirty: {:?}", dirty);
    assert!(!dirty[0].is_session);
    assert_eq!(dirty[0].identifier, sub_identifier);

    // The composed value reads back through the sublayer opinion.
    let details = details_via_owner(&state, "/Scene/Sub", None);
    let radius = attribute(&details, "radius");
    assert_eq!(radius.value.data, serde_json::json!(1.5));
}

#[test]
fn usdz_opened_stage_is_flagged_and_rejects_saves() {
    let (state, _events) = owner_with_events();

    // Package basic.usda into a real usdz archive, then open it directly.
    let dir = tempfile::tempdir().expect("temp dir");
    let usdz = dir.path().join("packed.usdz");
    let layer = openusd::sdf::Layer::open(fixture("basic.usda").to_string_lossy().as_ref())
        .expect("basic.usda opens as a layer");
    layer
        .export(usdz.to_string_lossy().as_ref())
        .expect("usdz export works");

    let info = open_path_via_owner(&state, &usdz);

    let target = edit_target(&state);
    assert!(target.is_usdz_stage, "usdz-opened stages are flagged");
    assert!(
        target.is_session,
        "the session layer stays the default target"
    );
    assert_eq!(info.root_layer, usdz.to_string_lossy().to_string());

    // Saving anything from a usdz-opened stage is refused (Task 7 adds
    // the Save As usdz path).
    let error = request_save_layers(
        &state.sender,
        &[LayerSaveRequest {
            identifier: info.root_layer.clone(),
            path: dir.path().join("nope.usda").to_string_lossy().to_string(),
        }],
    )
    .expect_err("usdz-opened stages cannot save layers");
    assert!(error.contains("usdz"), "got: {}", error);
}

/// Package basic.usda into a real usdz, extract it into the cache the way
/// `unpack_usdz` lays it out, and open the extracted .usdc carrying the
/// usdz origin flag — the exact shape of the File > Open dialog flow.
fn extract_usdz_like_the_dialog() -> PathBuf {
    use std::io::Write;

    let dir = tempfile::tempdir().expect("temp dir");
    let usdc = dir.path().join("root.usdc");
    let layer = openusd::sdf::Layer::open(fixture("basic.usda").to_string_lossy().as_ref())
        .expect("basic.usda opens as a layer");
    layer
        .export(usdc.to_string_lossy().as_ref())
        .expect("usdc export works");

    let archive_path = dir.path().join("packed.usdz");
    let mut writer =
        zip::ZipWriter::new(std::fs::File::create(&archive_path).expect("usdz create"));
    writer
        .start_file("root.usdc", zip::write::SimpleFileOptions::default())
        .expect("root entry");
    writer
        .write_all(&std::fs::read(&usdc).expect("usdc bytes"))
        .expect("root entry bytes");
    writer.finish().expect("usdz finish");

    let extracted = usdbee_lib::get_usdbee_cache_dir()
        .join("extracted")
        .join(format!("usdz_dialog_pin_{}", std::process::id()));
    std::fs::create_dir_all(&extracted).expect("extracted root");
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&archive_path).expect("usdz opens"))
        .expect("usdz parses");
    let mut entry = archive.by_name("root.usdc").expect("root entry");
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut entry, &mut bytes).expect("entry reads");
    let extracted_root = extracted.join("root.usdc");
    std::fs::write(&extracted_root, bytes).expect("entry extracts");
    extracted_root
}

#[test]
fn usdz_opened_via_extraction_flow_is_flagged_and_rejects_saves() {
    let (state, _events) = owner_with_events();

    // The dialog flow: .usdz extracted to the cache, .usdc opened with the
    // usdz origin flag — the suffix alone must not un-flag the stage.
    let extracted_root = extract_usdz_like_the_dialog();
    let info = request_stage_open(&extracted_root, true, &state.sender)
        .expect("extracted usdz root should open");

    let target = edit_target(&state);
    assert!(
        target.is_usdz_stage,
        "a stage opened from an extracted usdz must be flagged: {}",
        extracted_root.display()
    );
    assert_eq!(
        info.root_layer,
        extracted_root.to_string_lossy().to_string()
    );

    // Saving anything from this stage is refused — the save must never
    // write over the cache extraction while the user's .usdz sits unchanged.
    let error = request_save_layers(
        &state.sender,
        &[LayerSaveRequest {
            identifier: info.root_layer.clone(),
            path: extracted_root
                .parent()
                .unwrap()
                .join("sneaky.usda")
                .to_string_lossy()
                .to_string(),
        }],
    )
    .expect_err("usdz-origin stages cannot save layers");
    assert!(error.contains("usdz"), "got: {}", error);

    // Direct .usdz opens (suffix derivation) stay flagged too.
    let dir = tempfile::tempdir().expect("temp dir");
    let usdz = dir.path().join("direct.usdz");
    let layer = openusd::sdf::Layer::open(fixture("basic.usda").to_string_lossy().as_ref())
        .expect("basic.usda opens as a layer");
    layer
        .export(usdz.to_string_lossy().as_ref())
        .expect("usdz export works");
    request_stage_open(&usdz, false, &state.sender).expect("direct usdz opens");
    assert!(
        edit_target(&state).is_usdz_stage,
        "direct opens derive the flag"
    );

    // And a plain .usda open is not flagged.
    request_stage_open(&fixture("basic.usda"), false, &state.sender).expect("plain usda opens");
    assert!(
        !edit_target(&state).is_usdz_stage,
        "plain opens stay savable"
    );

    std::fs::remove_dir_all(extracted_root.parent().expect("extracted parent"))
        .expect("extracted pin cleanup");
}

#[test]
fn save_layers_is_all_or_nothing_when_a_later_request_is_invalid() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    // Two dirty layers: session and root.
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(1.5)),
        None,
    )
    .expect("session edit should succeed");
    request_set_edit_target(&state.sender, Some(&info.root_layer)).expect("switch to root");
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("root edit should succeed");
    let dirty_before = request_list_dirty_layers(&state.sender).expect("dirty layers list");
    assert_eq!(dirty_before.len(), 2, "both layers start dirty");

    // First request is valid, second fails validation: nothing may be
    // written and the dirty state must stay untouched.
    let dir = tempfile::tempdir().expect("temp dir");
    let first = dir.path().join("first.usda");
    let error = request_save_layers(
        &state.sender,
        &[
            LayerSaveRequest {
                identifier: info.root_layer.clone(),
                path: first.to_string_lossy().to_string(),
            },
            LayerSaveRequest {
                identifier: info.root_layer.clone(),
                path: "/tmp/sneaky.exe".to_string(),
            },
        ],
    )
    .expect_err("the invalid second request must fail the whole batch");
    assert!(error.contains("exe"), "got: {}", error);
    assert!(
        !first.exists(),
        "the valid first request must not be written"
    );
    let dirty_after = request_list_dirty_layers(&state.sender).expect("dirty layers list");
    let ids = |layers: &[usdbee_lib::stage::LayerInfo]| {
        layers
            .iter()
            .map(|l| l.identifier.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids(&dirty_before),
        ids(&dirty_after),
        "the dirty state is unchanged after the refused batch"
    );

    // The same batch with the bad request fixed saves both layers.
    let second = dir.path().join("second.usda");
    let session_id = dirty_before
        .iter()
        .find(|l| l.is_session)
        .expect("session entry")
        .identifier
        .clone();
    request_save_layers(
        &state.sender,
        &[
            LayerSaveRequest {
                identifier: info.root_layer.clone(),
                path: first.to_string_lossy().to_string(),
            },
            LayerSaveRequest {
                identifier: session_id,
                path: second.to_string_lossy().to_string(),
            },
        ],
    )
    .expect("a fully valid batch saves everything");
    assert!(first.exists() && second.exists(), "both files are written");
    let dirty = request_list_dirty_layers(&state.sender).expect("dirty layers list");
    assert!(dirty.is_empty(), "both layers are clean: {:?}", dirty);
}

#[test]
fn set_metadata_active_true_reactivates_an_inactive_prim() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender,
        "/World/Ball",
        "active",
        &payload("bool", serde_json::json!(false)),
    )
    .expect("deactivating a prim should succeed");

    // Reactivation is the ONE mutation allowed on an inactive prim.
    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender,
        "/World/Ball",
        "active",
        &payload("bool", serde_json::json!(true)),
    )
    .expect("reactivating via active=true metadata should succeed");

    let tree = request_stage_tree(&state.sender).expect("tree should serialize");
    let world = &tree[0];
    let ball = world
        .children
        .iter()
        .find(|n| n.path == "/World/Ball")
        .expect("the prim stays in the tree");
    assert!(ball.is_active, "the prim is active again");

    // Every other mutation on a re-deactivated prim is still rejected.
    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender,
        "/World/Ball",
        "active",
        &payload("bool", serde_json::json!(false)),
    )
    .expect("deactivate again");
    let error = usdbee_lib::stage::request_set_prim_metadata(
        &state.sender,
        "/World/Ball",
        "kind",
        &payload("token", serde_json::json!("prop")),
    )
    .expect_err("non-reactivation metadata on an inactive prim must fail");
    assert!(error.contains("inactive"), "got: {}", error);
}
