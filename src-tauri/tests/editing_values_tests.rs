mod common;

use usdbee_lib::stage::{
    request_geometry_data, request_list_dirty_layers, request_save_layers, request_scene_manifest,
    request_stage_tree, LayerSaveRequest, RenderNode,
};

use common::{
    attribute, details_via_owner, open_via_owner, owner_with_events, payload, request_set_value,
    request_undo, undo_state,
};

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
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
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
fn set_value_authors_a_single_display_color_element() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    request_set_value(
        &state,
        "/World/Ball",
        "primvars:displayColor",
        payload("color3f_array", serde_json::json!([[1.0, 0.25, 0.0]])),
        None,
    )
    .expect("authoring a 1-element displayColor should succeed");

    // The composed detail reads the authored value back (round trip).
    let details = details_via_owner(&state, "/World/Ball", None);
    let color = attribute(&details, "primvars:displayColor");
    assert!(color.authored);
    assert_eq!(color.type_name, "color3f[]");
    assert_eq!(color.value.r#type, "color3f_array");
    assert_eq!(
        color.value.data,
        serde_json::json!([[1.0, 0.25, 0.0]]),
        "compose back must read the same color"
    );

    // The edit dirties exactly the session layer.
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(dirty.len(), 1, "dirty layers: {dirty:?}");
    assert!(dirty[0].is_session);

    // usd-stage-changed fires with the edited prim path.
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("usd-stage-changed should fire after the color edit");
    assert_eq!(paths, vec!["/World/Ball".to_string()]);

    // Undo reverts the authored color to the fixture value.
    assert!(undo_state(&state).can_undo);
    assert!(request_undo(&state).expect("undo succeeds"));
    let details = details_via_owner(&state, "/World/Ball", None);
    let color = attribute(&details, "primvars:displayColor");
    assert_eq!(
        color.value.data,
        serde_json::json!([[0.5, 0.5, 0.5]]),
        "undo must restore the pre-edit color"
    );
}

#[test]
fn set_value_stamps_the_schema_declared_unauthored_display_color() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "display_color.usda");

    // /World/Blank authors no displayColor: the gprim schema declares it,
    // so set stamps the spec from the declaration (no create call).
    request_set_value(
        &state,
        "/World/Blank",
        "primvars:displayColor",
        payload("color3f_array", serde_json::json!([[0.0, 1.0, 0.0]])),
        None,
    )
    .expect("authoring an unauthored schema-declared displayColor should succeed");

    let details = details_via_owner(&state, "/World/Blank", None);
    let color = attribute(&details, "primvars:displayColor");
    assert!(color.authored);
    assert_eq!(color.type_name, "color3f[]");
    assert_eq!(color.value.r#type, "color3f_array");
    assert_eq!(color.value.data, serde_json::json!([[0.0, 1.0, 0.0]]));
}

#[test]
fn float3_array_authors_one_element_and_refuses_longer_arrays() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    // A fresh float3[] attribute: the builder path creates the spec and
    // authors the value as one undo step.
    request_set_value(
        &state,
        "/World/Ball",
        "float3Vec",
        payload("float3_array", serde_json::json!([[1.0, 2.0, 3.0]])),
        None,
    )
    .expect("a fresh float3[] attribute should create with one value");
    let details = details_via_owner(&state, "/World/Ball", None);
    let fresh = attribute(&details, "float3Vec");
    assert!(fresh.authored);
    assert_eq!(fresh.type_name, "float3[]");
    // A non-color vec3-family array serializes with the generic tag.
    assert_eq!(fresh.value.r#type, "vec3f_array");
    assert_eq!(fresh.value.data, serde_json::json!([[1.0, 2.0, 3.0]]));

    // Longer arrays stay refused with the not-yet-editable error.
    for (tag, data) in [
        (
            "color3f_array",
            serde_json::json!([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]),
        ),
        (
            "float3_array",
            serde_json::json!([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]),
        ),
    ] {
        let error = request_set_value(
            &state,
            "/World/Ball",
            "primvars:displayColor",
            payload(tag, data),
            None,
        )
        .expect_err("multi-element arrays must refuse");
        assert!(error.contains("not editable"), "{tag}: {}", error);
    }

    // A malformed single element (wrong component count) refuses readably.
    for (tag, data) in [
        ("color3f_array", serde_json::json!([[0.1, 0.2, 0.3, 0.4]])),
        ("color3f_array", serde_json::json!([[0.1, 0.2]])),
        ("float3_array", serde_json::json!([[0.1, 0.2, 0.3, 0.4]])),
        ("float3_array", serde_json::json!([[0.1, 0.2]])),
    ] {
        let error = request_set_value(
            &state,
            "/World/Ball",
            "primvars:displayColor",
            payload(tag, data),
            None,
        )
        .expect_err("malformed single elements must refuse");
        assert!(
            error.contains("needs exactly 3 components"),
            "{tag}: {}",
            error
        );
    }
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

#[test]
fn set_value_on_a_prototype_prim_is_refused_before_any_emission() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "instanced.usda");

    // openusd refuses authoring into the instancing prototype namespace
    // outright (C++ `_ValidateEditPrim`), so a prototype-path write never
    // reaches the emission. Pin both halves of that reality: the refusal,
    // and that no usd-stage-changed fires for it.
    let error = request_set_value(
        &state,
        "/__Prototype_0/Wheel",
        "radius",
        payload("double", serde_json::json!(1.5)),
        None,
    )
    .expect_err("authoring into a prototype must fail");
    assert!(
        error.contains("prototype"),
        "the error must name the prototype rule, got: {}",
        error
    );
    assert!(
        events
            .recv_timeout(std::time::Duration::from_millis(200))
            .is_err(),
        "a refused write must not emit usd-stage-changed"
    );
}

#[test]
fn default_time_and_sampled_writes_keep_per_path_emission() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "instanced.usda");

    // The warm arm (a default-time xform write: kept tree + skeleton)...
    request_set_value(
        &state,
        "/Scene",
        "xformOp:translate",
        payload("double3", serde_json::json!([2.0, 0.0, 0.0])),
        None,
    )
    .expect("default-time xform write should succeed");
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("usd-stage-changed should fire after the warm write");
    assert_eq!(paths, vec!["/Scene".to_string()]);

    // ...and the cold arm (a sampled write) keep the per-path emission.
    request_set_value(
        &state,
        "/Scene",
        "xformOp:translate",
        payload("double3", serde_json::json!([3.0, 0.0, 0.0])),
        Some(1.0),
    )
    .expect("sampled write should succeed");
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("usd-stage-changed should fire after the sampled write");
    assert_eq!(paths, vec!["/Scene".to_string()]);
}

#[test]
fn set_value_time_sample_reads_back_and_clears_caches() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "animated.usda");
    // The idle-gap warmup would fill caches behind these requests: switch it
    // off so the tessellation counter is this test's own.
    state.disable_warmup();

    // Prime the tessellation cache with one geometry fetch (Still authors
    // default-time points; Wobble's are sampled, so default time has none).
    request_geometry_data(&state.sender(), "/Scene/Still", None).expect("geometry fetches");
    let before = state.mesh_tessellations();
    request_geometry_data(&state.sender(), "/Scene/Still", None).expect("geometry re-fetches");
    assert_eq!(
        state.mesh_tessellations(),
        before,
        "a warm fetch tessellates nothing"
    );

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
    // (The warmup is off, so nothing refills it behind this request.)
    let cleared = state.mesh_tessellations();
    request_geometry_data(&state.sender(), "/Scene/Still", None).expect("geometry refetches");
    assert_eq!(state.mesh_tessellations(), cleared + 1);
}

#[test]
fn xform_value_write_keeps_serving_the_fresh_transform() {
    // Pins correctness ACROSS the cache-keep change: a default-time xform value
    // write may keep the manifest skeleton, so the edited prim's cached static
    // transform must not survive it.
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    // Warm both caches the way a viewport does before an edit.
    request_stage_tree(&state.sender()).expect("tree should serialize");
    let warm = request_scene_manifest(&state.sender(), None).expect("manifest serializes");
    let before = render_node(&warm, "/World");
    assert_eq!(before.transform[12], 1.0, "the authored translate");

    request_set_value(
        &state,
        "/World",
        "xformOp:translate",
        payload("double3", serde_json::json!([5.0, 6.0, 7.0])),
        None,
    )
    .expect("authoring the translate should succeed");

    let edited = request_scene_manifest(&state.sender(), None).expect("manifest serializes");
    let after = render_node(&edited, "/World");
    assert_eq!(
        [
            after.transform[12],
            after.transform[13],
            after.transform[14]
        ],
        [5.0, 6.0, 7.0],
        "the new translate, not the cached one"
    );

    let details = details_via_owner(&state, "/World", None);
    assert_eq!(
        attribute(&details, "xformOp:translate").value.data,
        serde_json::json!([5.0, 6.0, 7.0])
    );
}

fn render_node<'a>(nodes: &'a [RenderNode], path: &str) -> &'a RenderNode {
    nodes
        .iter()
        .flat_map(|node| std::iter::once(node).chain(descendants(node)))
        .find(|node| node.path == path)
        .unwrap_or_else(|| panic!("expected manifest node {}", path))
}

fn descendants(node: &RenderNode) -> Box<dyn Iterator<Item = &RenderNode> + '_> {
    Box::new(
        node.children
            .iter()
            .flat_map(|child| std::iter::once(child).chain(descendants(child))),
    )
}

#[test]
fn set_value_authors_xform_op_vectors_and_order() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "xforms.usda");

    // Existing double3 translate: the gizmo authors the declared spelling.
    request_set_value(
        &state,
        "/World",
        "xformOp:translate",
        payload("double3", serde_json::json!([11, 0, 0])),
        None,
    )
    .expect("authoring a double3 translate should succeed");
    let details = details_via_owner(&state, "/World", None);
    assert_eq!(
        attribute(&details, "xformOp:translate").value.data,
        serde_json::json!([11.0, 0.0, 0.0])
    );

    // A rotateXYZ the prim never authored: created as float3, then
    // xformOpOrder re-authored as a token array with the op appended at
    // the END of the list (most-local, the gizmo contract).
    request_set_value(
        &state,
        "/World",
        "xformOp:rotateXYZ",
        payload("float3", serde_json::json!([0, 0, 90])),
        None,
    )
    .expect("creating a float3 rotateXYZ should succeed");
    request_set_value(
        &state,
        "/World",
        "xformOpOrder",
        payload(
            "token_array",
            serde_json::json!(["xformOp:translate", "xformOp:rotateXYZ"]),
        ),
        None,
    )
    .expect("authoring the token-array order should succeed");

    let details = details_via_owner(&state, "/World", None);
    assert_eq!(
        attribute(&details, "xformOpOrder").value.data,
        serde_json::json!(["xformOp:translate", "xformOp:rotateXYZ"])
    );

    // Composed local: first-listed translate applies LAST, so points
    // rotate 90 deg about Z first, then move +11 along X (row-vector
    // convention: translation in the LAST ROW, the w column stays 0).
    let local = details
        .local_transform
        .expect("local transform should compose");
    let expected = [
        0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 11.0, 0.0, 0.0, 1.0,
    ];
    for (got, want) in local.iter().zip(expected) {
        assert!(
            (got - want).abs() < 1e-9,
            "local transform {:?} != {:?}",
            local,
            expected
        );
    }

    // Wrong-shape payloads refuse readably instead of authoring garbage.
    let bad = request_set_value(
        &state,
        "/World",
        "xformOp:translate",
        payload("double3", serde_json::json!([1, 2])),
        None,
    );
    assert!(bad.is_err());
}

#[test]
fn set_value_creates_the_first_op_and_order_on_a_plain_prim() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    // /World/Ball authors no xform ops at all: identity local transform,
    // never None (the gizmo gate keeps plain prims editable).
    let before = details_via_owner(&state, "/World/Ball", None);
    let identity = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];
    assert_eq!(before.local_transform, Some(identity));

    // The create-op flow: author the op, then xformOpOrder from scratch.
    request_set_value(
        &state,
        "/World/Ball",
        "xformOp:translate",
        payload("double3", serde_json::json!([2, 0, 0])),
        None,
    )
    .expect("creating the first translate should succeed");
    request_set_value(
        &state,
        "/World/Ball",
        "xformOpOrder",
        payload("token_array", serde_json::json!(["xformOp:translate"])),
        None,
    )
    .expect("authoring the order from scratch should succeed");

    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&details, "xformOpOrder").value.data,
        serde_json::json!(["xformOp:translate"])
    );
    let local = details.local_transform.expect("the created op composes");
    let expected = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 0.0, 1.0,
    ];
    for (got, want) in local.iter().zip(expected) {
        assert!(
            (got - want).abs() < 1e-9,
            "local transform {:?} != {:?}",
            local,
            expected
        );
    }
}

// Uniform attributes (the schema declares Imageable.purpose uniform)
// author their DEFAULT, never a time sample: the editor passes a null time
// code for uniform variability (Task 5 fix 2b), so the authored value reads
// back identically at every time code and the saved layer text carries no
// timeSamples block.
#[test]
fn uniform_attribute_edits_author_the_default_not_a_time_sample() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    let details = details_via_owner(&state, "/World/Ball", None);
    let purpose = attribute(&details, "purpose");
    assert_eq!(purpose.variability, "uniform");
    assert!(!purpose.authored);

    request_set_value(
        &state,
        "/World/Ball",
        "purpose",
        payload("token", serde_json::json!("render")),
        None,
    )
    .expect("setting a uniform attribute should succeed");

    for time in [None, Some(0.0), Some(999.0)] {
        let details = details_via_owner(&state, "/World/Ball", time);
        let purpose = attribute(&details, "purpose");
        assert!(purpose.authored);
        assert_eq!(
            purpose.value.data,
            serde_json::json!("render"),
            "the uniform edit reads identically at time {:?}",
            time
        );
    }

    // The session layer's authored text proves no time sample landed: a
    // sampled authoring would spell `purpose.timeSamples = {...}`.
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    let session = dirty.iter().find(|l| l.is_session).expect("session entry");
    let dir = tempfile::tempdir().expect("temp dir");
    let saved = dir.path().join("uniform-check.usda");
    request_save_layers(
        &state.sender(),
        &[LayerSaveRequest {
            identifier: session.identifier.clone(),
            path: saved.to_string_lossy().to_string(),
        }],
    )
    .expect("saving the session layer should succeed");
    let text = std::fs::read_to_string(&saved).expect("saved session reads");
    assert!(
        text.contains("purpose"),
        "the authored uniform opinion is in:\n{}",
        text
    );
    assert!(
        !text.contains("timeSamples"),
        "a uniform attribute must not author time samples:\n{}",
        text
    );
}
