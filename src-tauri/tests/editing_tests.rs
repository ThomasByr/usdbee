use std::path::PathBuf;
use std::sync::mpsc;

use usdbee_lib::stage::{
    request_geometry_data, request_stage_details, request_stage_tree, spawn_stage_owner_with_sink,
    StageRequest, StageState,
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
    let dirty = state.dirty_layer().expect("an edit marks the stage dirty");
    assert!(
        dirty.contains("session"),
        "dirty layer should be the session layer, got {}",
        dirty
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
