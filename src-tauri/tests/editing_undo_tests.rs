mod common;

use usdbee_lib::stage::{
    request_geometry_data, request_list_dirty_layers, request_save_layers, request_stage_tree,
    LayerSaveRequest,
};

use common::{
    attribute, details_via_owner, open_via_owner, owner_with_events, payload, request_redo,
    request_set_value, request_set_variant_selection, request_undo, spawn_stage_owner, undo_state,
    variant_set,
};

// FIRST undo pin (the Task 1 review flagged undo capture as spike-only
// evidence): an authored value must revert through the actor's own UndoStage
// wrap, the stack must drain (can_undo false), and redo must restore the
// value. Undo is not merely the inverse of the write: it must also clear the
// caches (the mesh cache re-tessellates), emit usd-stage-changed for the
// edited path, and restore the dirty-layer bookkeeping coherently (the
// undone edit leaves the session layer clean again).
#[test]
fn undo_reverts_an_authored_value_and_drains() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    // Prime the mesh cache so the undo's cache clear is observable.
    request_geometry_data(&state.sender(), "/World/Ball", None).expect("geometry fetches");
    let tessellations_after_open = state.mesh_tessellations();

    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("setting an authored float should succeed");
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("the mutation emits usd-stage-changed");
    assert_eq!(paths, vec!["/World/Ball".to_string()]);

    let undo = undo_state(&state);
    assert!(undo.can_undo, "one edit is on the undo stack");
    assert!(!undo.can_redo, "nothing to redo before any undo");

    // The edit refilled the cache; fetch again so the undo's clear is the
    // only thing that can force the next re-tessellation.
    request_geometry_data(&state.sender(), "/World/Ball", None).expect("geometry refetches");

    assert!(request_undo(&state).expect("undo should succeed"));
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&details, "radius").value.data,
        serde_json::json!(1.0),
        "the root layer's original radius composes again"
    );

    let undo = undo_state(&state);
    assert!(!undo.can_undo, "the single edit drained the stack");
    assert!(undo.can_redo, "the undone edit is redoable");

    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("undo emits usd-stage-changed too");
    assert_eq!(paths, vec!["/World/Ball".to_string()]);

    // The undo cleared the caches: the fetch re-tessellates.
    request_geometry_data(&state.sender(), "/World/Ball", None).expect("geometry refetches");
    assert!(
        state.mesh_tessellations() > tessellations_after_open + 1,
        "undo cleared the mesh cache: {} vs {}",
        state.mesh_tessellations(),
        tessellations_after_open + 1
    );

    // Dirty state restores coherently: the undone edit no longer leaves
    // the session layer dirty.
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert!(dirty.is_empty(), "the reverted edit leaves no dirty layer");

    // Redo restores the value, re-marks the session layer dirty and emits
    // the same path again.
    assert!(request_redo(&state).expect("redo should succeed"));
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&details, "radius").value.data,
        serde_json::json!(2.5)
    );
    let undo = undo_state(&state);
    assert!(undo.can_undo, "the redone edit is undoable again");
    assert!(!undo.can_redo, "the redo stack drained");
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(
        dirty.len(),
        1,
        "the redone edit re-dirties the session layer"
    );
    assert!(dirty[0].is_session);
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("redo emits usd-stage-changed too");
    assert_eq!(paths, vec!["/World/Ball".to_string()]);
}

// The gizmo's undo/redo pair: a default-time xform write reverts a matrix, so
// the reverted state can falsify neither the tree shape nor any sibling
// skeleton fact — the same reasoning the SetValue warm arm rests on (see
// .agents/knowledge/gizmo-edit-commit-costs.md). The tree serialization
// counter is the observable: a kept tree means no serialize_tree walk, so the
// undo button costs ~0.4 ms instead of ~700 ms on a big scene.
#[test]
fn undo_and_redo_of_a_default_time_xform_write_keep_the_tree() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    // Two fetches: the first serializes, the second is served from the cache
    // (the counter counts builds, not replies).
    request_stage_tree(&state.sender()).expect("tree should serialize");
    request_stage_tree(&state.sender()).expect("tree should serialize");
    assert_eq!(
        state.stage_tree_serializations(),
        1,
        "one build serves every cached reply"
    );

    // Prime the mesh cache so the warm path's own clear stays observable.
    request_geometry_data(&state.sender(), "/World/Ball", None).expect("geometry fetches");
    let tessellations_before_write = state.mesh_tessellations();

    // `/World` already authors `xformOp:translate`, so the undo has a root
    // opinion to compose back to.
    request_set_value(
        &state,
        "/World",
        "xformOp:translate",
        payload("double3", serde_json::json!([9.0, 0.0, 0.0])),
        None,
    )
    .expect("a default-time xform write should succeed");
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("the mutation emits usd-stage-changed");
    assert_eq!(paths, vec!["/World".to_string()]);
    assert_eq!(
        state.stage_tree_serializations(),
        1,
        "the write kept the tree"
    );

    // The warm write still clears the mesh cache (tessellation may bake
    // transform-dependent skinning), and the refetch re-primes it.
    request_geometry_data(&state.sender(), "/World/Ball", None).expect("geometry refetches");
    assert!(
        state.mesh_tessellations() > tessellations_before_write,
        "the write cleared the mesh cache: {} vs {}",
        state.mesh_tessellations(),
        tessellations_before_write
    );
    let tessellations_before_undo = state.mesh_tessellations();

    assert!(request_undo(&state).expect("undo should succeed"));
    let details = details_via_owner(&state, "/World", None);
    assert_eq!(
        attribute(&details, "xformOp:translate").value.data,
        serde_json::json!([1.0, 2.0, 3.0]),
        "the root layer's original translate composes again"
    );
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("undo emits usd-stage-changed too");
    assert_eq!(paths, vec!["/World".to_string()]);
    // The regression this pins: a coarse after_mutation would have emptied
    // the tree, so this fetch would count a second serialization.
    request_stage_tree(&state.sender()).expect("tree should serialize");
    assert_eq!(
        state.stage_tree_serializations(),
        1,
        "undoing an xform write keeps the tree"
    );

    // The tree survives the undo, the tessellations do not.
    request_geometry_data(&state.sender(), "/World/Ball", None).expect("geometry refetches");
    assert!(
        state.mesh_tessellations() > tessellations_before_undo,
        "undo cleared the mesh cache: {} vs {}",
        state.mesh_tessellations(),
        tessellations_before_undo
    );
    let tessellations_before_redo = state.mesh_tessellations();

    assert!(request_redo(&state).expect("redo should succeed"));
    let details = details_via_owner(&state, "/World", None);
    assert_eq!(
        attribute(&details, "xformOp:translate").value.data,
        serde_json::json!([9.0, 0.0, 0.0])
    );
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("redo emits usd-stage-changed too");
    assert_eq!(paths, vec!["/World".to_string()]);
    request_stage_tree(&state.sender()).expect("tree should serialize");
    assert_eq!(
        state.stage_tree_serializations(),
        1,
        "redoing an xform write keeps the tree"
    );
    request_geometry_data(&state.sender(), "/World/Ball", None).expect("geometry refetches");
    assert!(
        state.mesh_tessellations() > tessellations_before_redo,
        "redo cleared the mesh cache: {} vs {}",
        state.mesh_tessellations(),
        tessellations_before_redo
    );
}

// The cold control: any other mutation can reshape the composed tree, so its
// undo keeps the coarse clear.
#[test]
fn undo_of_a_non_xform_write_rebuilds_the_tree() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    request_stage_tree(&state.sender()).expect("tree should serialize");
    assert_eq!(state.stage_tree_serializations(), 1);

    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("setting an authored float should succeed");
    assert!(request_undo(&state).expect("undo should succeed"));

    request_stage_tree(&state.sender()).expect("tree should serialize");
    assert_eq!(
        state.stage_tree_serializations(),
        2,
        "a non-xform undo rebuilds the tree exactly once"
    );
}

// Creating an attribute (spec + value) is ONE undo step: a create + set
// split across two transactions would leave a half-created attribute after
// one undo.
#[test]
fn undo_reverts_a_created_attribute_in_one_step() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    request_set_value(
        &state,
        "/World/Ball",
        "freshAttr",
        payload("double", serde_json::json!(-1.25)),
        None,
    )
    .expect("creating a new attribute should succeed");
    let details = details_via_owner(&state, "/World/Ball", None);
    assert!(attribute(&details, "freshAttr").authored);

    assert!(request_undo(&state).expect("one undo reverts the creation"));
    let details = details_via_owner(&state, "/World/Ball", None);
    assert!(
        details.attributes.iter().all(|a| a.name != "freshAttr"),
        "the created attribute is gone after one undo: {:?}",
        details.attributes
    );
    let undo = undo_state(&state);
    assert!(!undo.can_undo, "the creation was the only undo entry");
    assert!(request_redo(&state).expect("redo restores the creation"));
    let details = details_via_owner(&state, "/World/Ball", None);
    assert!(attribute(&details, "freshAttr").authored);
}

// Undo/redo must cover the other mutation families, not just attribute
// values: prim metadata (kind) and variant selections — a variant undo
// recomposes the tree (the selected variant's children appear/disappear).
#[test]
fn undo_redo_covers_metadata_and_variant_selections() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender(),
        "/World/Ball",
        "kind",
        &payload("token", serde_json::json!("prop")),
    )
    .expect("setting kind should succeed");
    assert!(request_undo(&state).expect("undo of the metadata edit"));
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(details.kind, "", "the pre-edit kind composes again");
    assert!(request_redo(&state).expect("redo of the metadata edit"));
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(details.kind, "prop");

    // Variant selections: the root layer authors color = "red".
    open_via_owner(&state, "variants.usda");
    request_set_variant_selection(&state, "/Prop", "color", Some("blue"))
        .expect("selecting a variant should succeed");
    assert!(request_undo(&state).expect("undo of the selection"));
    let details = details_via_owner(&state, "/Prop", None);
    assert_eq!(
        variant_set(&details, "color").authored_selection.as_deref(),
        Some("red"),
        "the root layer's selection composes again"
    );
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    assert!(
        !tree[0].children.iter().any(|c| c.path == "/Prop/BlueShape"),
        "the undone variant's child is gone: {:?}",
        tree[0].children
    );
    assert!(request_redo(&state).expect("redo of the selection"));
    let details = details_via_owner(&state, "/Prop", None);
    assert_eq!(
        variant_set(&details, "color").authored_selection.as_deref(),
        Some("blue")
    );
}

// A new edit after an undo discards the redo stack (standard editor
// semantics); can_redo must reflect it.
#[test]
fn a_new_mutation_clears_the_redo_stack() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("edit one");
    assert!(request_undo(&state).expect("undo edit one"));
    assert!(undo_state(&state).can_redo);

    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(3.5)),
        None,
    )
    .expect("edit two");
    let undo = undo_state(&state);
    assert!(undo.can_undo);
    assert!(!undo.can_redo, "the new edit invalidated the redo stack");
    assert!(!request_redo(&state).expect("redo reports nothing to redo"));
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&details, "radius").value.data,
        serde_json::json!(3.5)
    );
}

// Dirty bookkeeping survives saves coherently: after saving, an undo back
// to the saved content un-dirties the layer, and undoing further than the
// save point re-dirties it (the in-memory layer now differs from the file).
#[test]
fn undo_restores_dirty_state_across_saves() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(1.5)),
        None,
    )
    .expect("session edit one");
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    let session = dirty.iter().find(|l| l.is_session).expect("session entry");

    let dir = tempfile::tempdir().expect("temp dir");
    let saved = dir.path().join("session-snapshot.usda");
    request_save_layers(
        &state.sender(),
        &[LayerSaveRequest {
            identifier: session.identifier.clone(),
            path: saved.to_string_lossy().to_string(),
        }],
    )
    .expect("saving the session layer should succeed");
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert!(dirty.is_empty(), "the save cleared the dirty state");

    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("session edit two");
    assert_eq!(
        request_list_dirty_layers(&state.sender())
            .expect("dirty layers list")
            .len(),
        1,
        "the second edit re-dirties the layer"
    );

    // Undo edit two: the layer content is back to the saved file — clean.
    assert!(request_undo(&state).expect("undo edit two"));
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert!(
        dirty.is_empty(),
        "undoing back to the saved content cleans the layer: {:?}",
        dirty
    );

    // Undo edit one: the layer no longer matches the saved file — dirty.
    assert!(request_undo(&state).expect("undo edit one"));
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(dirty.len(), 1, "undoing past the save re-dirties the layer");
    assert!(dirty[0].is_session);
}

#[test]
fn undo_redo_without_open_stage_fail() {
    // undo/redo/get_undo_state resolve their stage by id first: the lookup
    // is the refusal every shape shares.
    let state = spawn_stage_owner();
    let error = state.state.sender(0).expect_err("no stage is open");
    assert!(error.contains("no stage 0"), "got: {}", error);
}

// One gizmo commit is ONE undo step. The commit writes the mode op, its
// pivot-residual translate and the xformOpOrder separately; as three
// transactions the stack held entries whose value reverts composed to nothing
// (the order write reverts first and takes the ops out of the order), which
// read as dead undo presses. The batch request seals the commit as one entry.
fn commit_writes(time: Option<f64>) -> Vec<usdbee_lib::stage::AttributeWrite> {
    vec![
        usdbee_lib::stage::AttributeWrite {
            name: "xformOp:rotateXYZ".to_string(),
            value: payload("float3", serde_json::json!([10.0, 20.0, 30.0])),
            time,
        },
        usdbee_lib::stage::AttributeWrite {
            name: "xformOp:translate".to_string(),
            value: payload("double3", serde_json::json!([0.5, 0.0, 0.0])),
            time,
        },
        usdbee_lib::stage::AttributeWrite {
            name: "xformOpOrder".to_string(),
            value: payload(
                "token_array",
                serde_json::json!(["xformOp:translate", "xformOp:rotateXYZ"]),
            ),
            time: None,
        },
    ]
}

const IDENTITY: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

#[test]
fn one_batched_commit_costs_one_undo_and_one_redo() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");
    let before = details_via_owner(&state, "/World/Ball", None)
        .local_transform
        .expect("a prim with no ops reports an identity transform");
    assert_eq!(before, IDENTITY);

    usdbee_lib::stage::request_set_attribute_values(
        &state.sender(),
        "/World/Ball",
        &commit_writes(None),
    )
    .expect("the whole commit authors");

    let edited = details_via_owner(&state, "/World/Ball", None)
        .local_transform
        .expect("the commit authored a transform");
    assert_ne!(edited, before, "the commit moved and rotated the prim");

    assert!(request_undo(&state).expect("undo"));
    assert_eq!(
        details_via_owner(&state, "/World/Ball", None).local_transform,
        Some(before),
        "one undo restores the pre-commit pose exactly"
    );
    let undo = undo_state(&state);
    assert!(!undo.can_undo, "the commit was one entry, not three");
    assert!(undo.can_redo);

    // Redo symmetry: the redo applies the entry's diff as one transaction, so
    // it too leaves exactly one undo entry.
    assert!(request_redo(&state).expect("redo"));
    assert_eq!(
        details_via_owner(&state, "/World/Ball", None).local_transform,
        Some(edited),
        "one redo re-applies the whole commit"
    );
    assert!(request_undo(&state).expect("undo the redo"));
    assert!(
        !undo_state(&state).can_undo,
        "the redone commit is one entry too"
    );
    assert_eq!(
        details_via_owner(&state, "/World/Ball", None).local_transform,
        Some(before)
    );
}

// The animated path samples the op values at the playhead and authors the
// order at the default time — the same split, one entry.
#[test]
fn one_batched_commit_on_an_animated_stage_costs_one_undo() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "animated.usda");
    let time = Some(24.0);
    let before = details_via_owner(&state, "/Scene/Pulse", time)
        .local_transform
        .expect("the sampled translate composes");

    usdbee_lib::stage::request_set_attribute_values(
        &state.sender(),
        "/Scene/Pulse",
        &commit_writes(time),
    )
    .expect("the whole commit authors");

    let edited = details_via_owner(&state, "/Scene/Pulse", time)
        .local_transform
        .expect("the commit authored a transform");
    assert_ne!(edited, before);

    assert!(request_undo(&state).expect("undo"));
    assert_eq!(
        details_via_owner(&state, "/Scene/Pulse", time).local_transform,
        Some(before),
        "one undo restores the sampled pose exactly"
    );
    assert!(!undo_state(&state).can_undo, "the commit was one entry");
}

// All or nothing: a batch whose second write is refused authors no part of
// itself, so a half-applied commit can never reach the stage (or the stack).
#[test]
fn a_refused_batch_authors_nothing() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    let error = usdbee_lib::stage::request_set_attribute_values(
        &state.sender(),
        "/World/Ball",
        &[
            usdbee_lib::stage::AttributeWrite {
                name: "xformOp:translate".to_string(),
                value: payload("double3", serde_json::json!([1.0, 2.0, 3.0])),
                time: None,
            },
            // radius is declared float: a string value is refused.
            usdbee_lib::stage::AttributeWrite {
                name: "radius".to_string(),
                value: payload("string", serde_json::json!("nope")),
                time: None,
            },
        ],
    )
    .expect_err("the second write is refused");
    assert!(!error.is_empty());

    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        details.local_transform,
        Some(IDENTITY),
        "the first write did not land"
    );
    assert_eq!(
        attribute(&details, "radius").value.data,
        serde_json::json!(1.0),
        "the refused write left the declared value alone"
    );
    assert!(
        !undo_state(&state).can_undo,
        "nothing joined the undo stack"
    );
}
