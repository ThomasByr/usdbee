use std::io::Read;
use std::path::{Path, PathBuf};

mod common;

use usdbee_lib::stage::{
    request_geometry_data, request_list_dirty_layers, request_save_layers, request_scene_manifest,
    request_set_edit_target, request_stage_tree, LayerSaveRequest, RenderNode,
};
use usdbee_lib::values::PrimDetails;

use common::{
    attribute, details_via_owner, edit_target, fixture, open_path_via_owner, open_via_owner,
    owner_with_events, payload, request_redo, request_set_value, request_set_variant_selection,
    request_undo, spawn_stage_owner, undo_state, variant_set, TestOwner,
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

fn request_export_layer_text(state: &TestOwner, identifier: &str) -> Result<String, String> {
    usdbee_lib::stage::request_export_layer_text(&state.sender(), identifier)
}

fn request_import_layer_text(
    state: &TestOwner,
    identifier: &str,
    text: &str,
) -> Result<(), String> {
    usdbee_lib::stage::request_import_layer_text(&state.sender(), identifier, text)
}

fn request_list_stage_layers(
    state: &TestOwner,
) -> Result<Vec<usdbee_lib::stage::LayerInfo>, String> {
    usdbee_lib::stage::request_list_stage_layers(&state.sender())
}

#[test]
fn export_layer_text_serializes_the_root_layer_content() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    let text =
        request_export_layer_text(&state, &info.root_layer).expect("export should serialize");
    assert!(
        text.starts_with("#usda"),
        "usda text starts with the header:\n{}",
        text
    );
    assert!(
        text.contains("def Mesh \"Ball\""),
        "the prim is in:\n{}",
        text
    );
    assert!(
        text.contains("points = [(-1.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]"),
        "the authored points are in:\n{}",
        text
    );
    assert!(
        text.contains("radius = 1.0"),
        "the authored radius is in:\n{}",
        text
    );
}

#[test]
fn import_layer_text_updates_composed_values_and_marks_the_layer_dirty() {
    let (state, events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    let text = request_export_layer_text(&state, &info.root_layer).expect("export works");
    assert!(
        text.contains("radius = 1.0"),
        "the exported text has the value to edit"
    );
    let edited = text.replace("radius = 1.0", "radius = 9.5");
    request_import_layer_text(&state, &info.root_layer, &edited)
        .expect("importing valid text should succeed");

    // The composed details reflect the edited text.
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&details, "radius").value.data,
        serde_json::json!(9.5)
    );

    // The imported layer is dirty, listed with its own identity.
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(
        dirty.len(),
        1,
        "only the imported layer is dirty: {:?}",
        dirty
    );
    assert!(!dirty[0].is_session);
    assert_eq!(dirty[0].identifier, info.root_layer);

    // The import emits the same usd-stage-changed event as any mutation.
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("import emits usd-stage-changed");
    assert_eq!(paths, vec!["/".to_string()]);

    // The imported content round-trips through a fresh export.
    let re_exported = request_export_layer_text(&state, &info.root_layer).expect("re-export works");
    assert!(
        re_exported.contains("radius = 9.5"),
        "the edit persisted: {}",
        re_exported
    );
}

#[test]
fn import_malformed_text_is_a_readable_error_and_leaves_the_stage_untouched() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    let before_text = request_export_layer_text(&state, &info.root_layer).expect("export works");
    let before_details = details_via_owner(&state, "/World/Ball", None);

    let malformed = "#usda 1.0\ndef Mesh \"Ball\"\n{\n    float radius = not a number\n}\n";
    let error = request_import_layer_text(&state, &info.root_layer, malformed)
        .expect_err("malformed text must be refused");
    assert!(
        error.contains("basic.usda"),
        "the error carries the layer identifier context: {}",
        error
    );

    // The stage is byte-for-byte untouched: the layer text and the composed
    // values are identical to before.
    let after_text = request_export_layer_text(&state, &info.root_layer).expect("re-export works");
    assert_eq!(after_text, before_text, "the layer content is unchanged");
    let after_details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&after_details, "radius").value.data,
        attribute(&before_details, "radius").value.data
    );
    assert_eq!(
        attribute(&after_details, "points").value.data,
        attribute(&before_details, "points").value.data
    );

    // No dirty layer: a refused import mutated nothing.
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert!(
        dirty.is_empty(),
        "a refused import leaves nothing dirty: {:?}",
        dirty
    );
}

#[test]
fn import_into_the_session_layer_composes() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    let layers = request_list_stage_layers(&state).expect("layer list");
    let session = layers.iter().find(|l| l.is_session).expect("session entry");

    // The session layer is stronger than the root: the imported radius wins
    // (the prim path composes as /World/Ball, matching the root layer).
    let text = "#usda 1.0\n\ndef Xform \"World\"\n{\n    def Mesh \"Ball\"\n    {\n        float radius = 7.5\n    }\n}\n";
    request_import_layer_text(&state, &session.identifier, text)
        .expect("importing into the session layer should succeed");

    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&details, "radius").value.data,
        serde_json::json!(7.5)
    );

    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(dirty.len(), 1, "only the session layer is dirty");
    assert!(dirty[0].is_session);
}

#[test]
fn import_never_writes_the_layer_file() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    let file_before = std::fs::read(fixture("basic.usda")).expect("fixture reads");

    let text = request_export_layer_text(&state, &info.root_layer).expect("export works");
    let edited = text.replace("radius = 1.0", "radius = 9.5");
    request_import_layer_text(&state, &info.root_layer, &edited)
        .expect("importing into a file-backed layer should succeed");

    // The composed value changed, proving the in-memory layer took the edit...
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&details, "radius").value.data,
        serde_json::json!(9.5)
    );

    // ...while the file on disk stayed byte-for-byte identical.
    let file_after = std::fs::read(fixture("basic.usda")).expect("fixture reads");
    assert_eq!(
        file_before, file_after,
        "the layer file must never be written"
    );
}

#[test]
fn list_stage_layers_lists_all_layers_dirty_or_not() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    let layers = request_list_stage_layers(&state).expect("layer list");
    assert_eq!(layers.len(), 2, "session + root: {:?}", layers);
    assert!(
        layers.iter().any(|l| l.is_session),
        "the session layer is listed"
    );
    let root = layers.iter().find(|l| !l.is_session).expect("root entry");
    assert_eq!(root.identifier, info.root_layer);
    assert_eq!(
        root.original_path.as_deref(),
        Some(info.root_layer.as_str())
    );

    // A sublayer stage lists the sublayer too, still with nothing dirty.
    open_via_owner(&state, "sublayer_root.usda");
    let layers = request_list_stage_layers(&state).expect("layer list");
    assert_eq!(layers.len(), 3, "session + root + sublayer: {:?}", layers);
    assert!(layers
        .iter()
        .any(|l| l.identifier.ends_with("sublayer_sub.usda")));
    assert!(request_list_dirty_layers(&state.sender())
        .expect("dirty list")
        .is_empty());
}

#[test]
fn list_stage_layers_includes_referenced_layers_for_edit_target_selection() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "scene_with_ref.usda");

    let layers = request_list_stage_layers(&state).expect("layer list");
    assert!(
        layers
            .iter()
            .any(|layer| layer.identifier.ends_with("asset.usda")),
        "referenced layers are selectable edit targets: {layers:?}"
    );
}

#[test]
fn import_is_undoable_and_redoable() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    let text = request_export_layer_text(&state, &info.root_layer).expect("export works");
    let edited = text.replace("radius = 1.0", "radius = 9.5");
    request_import_layer_text(&state, &info.root_layer, &edited).expect("import should succeed");
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&details, "radius").value.data,
        serde_json::json!(9.5)
    );
    assert!(
        undo_state(&state).can_undo,
        "the import joined the undo stack"
    );

    // Undo restores the whole pre-import layer content.
    assert!(request_undo(&state).expect("undo of the import"));
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&details, "radius").value.data,
        serde_json::json!(1.0),
        "the original layer content composes again"
    );

    // Redo re-applies the imported content and re-dirties the layer.
    assert!(request_redo(&state).expect("redo of the import"));
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(
        attribute(&details, "radius").value.data,
        serde_json::json!(9.5)
    );
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(dirty.len(), 1, "the redone import re-dirties the layer");
    assert_eq!(dirty[0].identifier, info.root_layer);
}

#[test]
fn text_editor_failures_are_readable_and_fail_closed() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");

    // An unknown layer is refused with the identifier in the message.
    let error = request_export_layer_text(&state, "/nope/missing.usda")
        .expect_err("exporting an unknown layer must fail");
    assert!(error.contains("missing.usda"), "got: {}", error);
    let error = request_import_layer_text(&state, "/nope/missing.usda", "#usda 1.0\n")
        .expect_err("importing into an unknown layer must fail");
    assert!(error.contains("missing.usda"), "got: {}", error);

    // Without an open stage, every command refuses readably on the id
    // lookup (id 0: never minted).
    let bare = spawn_stage_owner();
    let error = bare.state.sender(0).expect_err("no stage is open");
    assert!(error.contains("no stage 0"), "got: {}", error);
    let error = bare.state.close_stage(0).expect_err("no stage is open");
    assert!(error.contains("no stage 0"), "got: {}", error);
}

#[test]
fn undo_redo_without_open_stage_fail() {
    // undo/redo/get_undo_state resolve their stage by id first: the lookup
    // is the refusal every shape shares.
    let state = spawn_stage_owner();
    let error = state.state.sender(0).expect_err("no stage is open");
    assert!(error.contains("no stage 0"), "got: {}", error);
}

fn request_set_texture(state: &TestOwner, path: &str, texture: Option<&str>) -> Result<(), String> {
    usdbee_lib::stage::request_set_prim_texture(&state.sender(), path, texture)
}

fn material_via_owner(state: &TestOwner, path: &str) -> usdbee_lib::materials::MaterialInfo {
    usdbee_lib::stage::request_material_data(&state.sender(), path)
        .expect("material data serializes")
}

fn child_node<'a>(
    nodes: &'a [usdbee_lib::stage::PrimNode],
    path: &str,
) -> &'a usdbee_lib::stage::PrimNode {
    nodes
        .iter()
        .find(|n| n.path == path)
        .unwrap_or_else(|| panic!("expected node {} in {:?}", path, nodes))
}

fn checker_texture() -> String {
    fixture("checker.png").to_string_lossy().to_string()
}

#[test]
fn set_prim_texture_binds_a_preview_surface_network() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "basic.usda");
    let texture = checker_texture();

    request_set_texture(&state, "/World/Ball", Some(&texture))
        .expect("binding a texture material should succeed");

    // The existing read path reports the texture: the authored network
    // must be complete enough for the viewport material flow.
    let material = material_via_owner(&state, "/World/Ball");
    assert_eq!(
        material.name, "World_Ball_Mat",
        "the full prim path names the bound material"
    );
    let surface = material
        .surface
        .expect("a UsdPreviewSurface composes from the authored network");
    assert_eq!(
        surface.textures.len(),
        1,
        "textures: {:?}",
        surface.textures
    );
    assert_eq!(surface.textures[0].input, "diffuseColor");
    assert_eq!(surface.textures[0].file_path, texture);
    assert_eq!(surface.textures[0].st_primvar, "st");
    assert_eq!(
        surface.diffuse_color, None,
        "diffuseColor arrives via the texture connection, not a value"
    );

    // The per-prim material path encodes the full prim path under /Looks
    // (a sibling of the default prim at the layer root).
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    let looks = child_node(&tree, "/Looks");
    assert_eq!(looks.type_name, "Scope");
    let mat = child_node(&looks.children, "/Looks/World_Ball_Mat");
    assert_eq!(mat.type_name, "Material");
    assert_eq!(
        mat.children.len(),
        2,
        "surface + texture shaders: {:?}",
        mat.children
    );

    // The edit dirtied exactly the session layer.
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(dirty.len(), 1, "dirty layers: {dirty:?}");
    assert!(dirty[0].is_session);

    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("usd-stage-changed fires for the texture edit");
    assert_eq!(paths, vec!["/World/Ball".to_string()]);
}

#[test]
fn set_prim_texture_clear_removes_the_binding_but_keeps_the_material() {
    let (state, events) = owner_with_events();
    open_via_owner(&state, "basic.usda");
    request_set_texture(&state, "/World/Ball", Some(&checker_texture()))
        .expect("binding should succeed");

    request_set_texture(&state, "/World/Ball", None)
        .expect("clearing the texture binding should succeed");

    let material = material_via_owner(&state, "/World/Ball");
    assert_eq!(material.name, "Ball");
    assert!(
        material.surface.is_none(),
        "no material is bound after the clear"
    );

    // The material prims stay (documented shortcut: no prim-removal path).
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    let looks = child_node(&tree, "/Looks");
    assert_eq!(
        child_node(&looks.children, "/Looks/World_Ball_Mat").type_name,
        "Material"
    );

    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("usd-stage-changed fires for the clear");
    assert_eq!(paths, vec!["/World/Ball".to_string()]);
}

#[test]
fn same_named_prims_keep_independent_texture_materials_and_undo() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "same_named_prims.usda");
    let texture_a = checker_texture();
    let texture_b = "/textures/a-different-image.png";

    request_set_texture(&state, "/A/Mesh", Some(&texture_a)).expect("first binding should succeed");
    request_set_texture(&state, "/B/Mesh", Some(texture_b)).expect("second binding should succeed");

    let material_a = material_via_owner(&state, "/A/Mesh");
    let material_b = material_via_owner(&state, "/B/Mesh");
    assert_ne!(material_a.name, material_b.name);
    assert_eq!(
        material_a.surface.expect("A stays bound").textures[0].file_path,
        texture_a
    );
    assert_eq!(
        material_b.surface.expect("B is bound").textures[0].file_path,
        texture_b
    );

    assert!(request_undo(&state).expect("undo B"));
    assert!(material_via_owner(&state, "/B/Mesh").surface.is_none());
    assert_eq!(
        material_via_owner(&state, "/A/Mesh")
            .surface
            .expect("A remains bound after undoing B")
            .textures[0]
            .file_path,
        texture_a
    );
    assert!(request_undo(&state).expect("undo A"));
    assert!(material_via_owner(&state, "/A/Mesh").surface.is_none());
}

#[test]
fn texture_binding_is_one_undo_step_and_redoable() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");
    let texture = checker_texture();
    request_set_texture(&state, "/World/Ball", Some(&texture)).expect("binding should succeed");

    let undo = undo_state(&state);
    assert!(undo.can_undo);
    assert!(!undo.can_redo);

    // ONE undo reverts the whole transaction: binding gone AND the created
    // material prims gone (one commit authored all of it).
    assert!(request_undo(&state).expect("one undo reverts the network"));
    let material = material_via_owner(&state, "/World/Ball");
    assert!(
        material.surface.is_none(),
        "the binding is gone after one undo"
    );
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    assert!(
        !tree.iter().any(|n| n.path == "/Looks"),
        "the /Looks prims vanish with the binding: {:?}",
        tree
    );
    assert!(
        !undo_state(&state).can_undo,
        "the stack drained in one step"
    );

    // Redo re-applies everything.
    assert!(request_redo(&state).expect("redo restores the network"));
    let material = material_via_owner(&state, "/World/Ball");
    let surface = material.surface.expect("the redone material composes");
    assert_eq!(surface.textures[0].file_path, texture);
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    assert!(tree.iter().any(|n| n.path == "/Looks"));
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(dirty.len(), 1);
    assert!(dirty[0].is_session);
}

#[test]
fn rebinding_a_texture_is_one_undo_step_back_to_the_previous_file() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");
    let checker = checker_texture();
    request_set_texture(&state, "/World/Ball", Some(&checker))
        .expect("first binding should succeed");

    // A missing file is authored verbatim (the picker passes absolute
    // paths; resolution happens at read time).
    let missing = "/definitely/not/a/texture.png";
    request_set_texture(&state, "/World/Ball", Some(missing)).expect("rebinding should succeed");
    let material = material_via_owner(&state, "/World/Ball");
    assert_eq!(
        material.surface.expect("still bound").textures[0].file_path,
        missing,
        "the authored spelling reads back when the file is missing"
    );

    assert!(request_undo(&state).expect("undo reverts the rebind"));
    let material = material_via_owner(&state, "/World/Ball");
    assert_eq!(
        material.surface.expect("rebound again").textures[0].file_path,
        checker
    );
}

#[test]
fn set_prim_texture_guards_instances_and_inactive_prims() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "instanced.usda");
    let error = request_set_texture(&state, "/Scene/WheelA", Some(&checker_texture()))
        .expect_err("binding a texture on an instance prim must fail");
    assert!(
        error.contains("/__Prototype_0"),
        "the error must name the prototype, got: {}",
        error
    );
    assert!(error.contains("instance"), "got: {}", error);

    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");
    usdbee_lib::stage::request_set_prim_metadata(
        &state.sender(),
        "/World/Ball",
        "active",
        &payload("bool", serde_json::json!(false)),
    )
    .expect("deactivating should succeed");
    let error = request_set_texture(&state, "/World/Ball", Some(&checker_texture()))
        .expect_err("binding a texture on an inactive prim must fail");
    assert!(
        error.contains("inactive"),
        "the inactive rejection stays readable, got: {}",
        error
    );
}

#[test]
fn two_concurrent_stages_edit_and_emit_independently() {
    let (state, events) = common::owner_with_events();
    let id_a = state.open(&fixture("basic.usda")).stage_id;
    let id_b = state.open(&fixture("variants.usda")).stage_id;
    assert_ne!(id_a, id_b, "each open mints a distinct stage id");
    assert!(
        id_a >= 1 && id_b >= 1,
        "ids start at 1; 0 stays \"no stage\""
    );

    // Independent trees: each stage composes its own fixture.
    let sender_a = state.state.sender(id_a).expect("stage A lives");
    let sender_b = state.state.sender(id_b).expect("stage B lives");
    let tree_a = request_stage_tree(&sender_a).expect("A's tree serializes");
    assert_eq!(tree_a[0].path, "/World");
    let tree_b = request_stage_tree(&sender_b).expect("B's tree serializes");
    assert_eq!(tree_b[0].path, "/Prop");

    // An edit in A dirties only A's session layer...
    usdbee_lib::stage::request_set_attribute_value(
        &sender_a,
        "/World/Ball",
        "radius",
        &payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("editing stage A should succeed");

    // ...and emits usd-stage-changed carrying A's id, never B's.
    let paths = events
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("A's edit emits usd-stage-changed");
    assert_eq!(paths, vec!["/World/Ball".to_string()]);
    assert_eq!(
        events.last_id(),
        id_a,
        "the event carries the edited stage's id"
    );

    let dirty_a = request_list_dirty_layers(&sender_a).expect("A's dirty list");
    assert_eq!(dirty_a.len(), 1, "A's session layer is dirty");
    let dirty_b = request_list_dirty_layers(&sender_b).expect("B's dirty list");
    assert!(
        dirty_b.is_empty(),
        "the edit in A must not touch B's dirty ledger: {dirty_b:?}"
    );
}

#[test]
fn close_stage_cleans_up_and_leaves_the_other_stage_functional() {
    let (state, _events) = common::owner_with_events();
    // Stage A opens like the dialog flow: a file inside an extraction dir
    // the owner thread must delete on close.
    let dir = tempfile::tempdir().expect("temp dir");
    let extraction = dir.path().join("extracted");
    std::fs::create_dir_all(&extraction).expect("extraction dir");
    std::fs::copy(fixture("basic.usda"), extraction.join("basic.usda")).expect("extracted root");
    let id_a = state
        .open_flow(
            &extraction.join("basic.usda"),
            false,
            None,
            Some(&extraction),
        )
        .stage_id;
    let id_b = state.open(&fixture("variants.usda")).stage_id;

    // A's session layer file exists right after the open.
    let sender_a = state.state.sender(id_a).expect("stage A lives");
    let layers = usdbee_lib::stage::request_list_stage_layers(&sender_a).expect("A's layer list");
    let session = layers.iter().find(|l| l.is_session).expect("session layer");
    let session_file = PathBuf::from(
        session
            .original_path
            .as_deref()
            .expect("the session layer is a real file"),
    );
    assert!(session_file.exists(), "session file exists while open");
    assert!(extraction.exists(), "extraction dir exists while open");

    state.state.close_stage(id_a).expect("close succeeds");

    assert!(
        !session_file.exists(),
        "close deletes the stage's session layer file"
    );
    assert!(
        !extraction.exists(),
        "close deletes the usdz extraction dir"
    );

    // Commands against the closed id fail readably.
    let error = state.state.sender(id_a).expect_err("the closed id is gone");
    assert!(
        error.contains(&format!("no stage {}", id_a)),
        "got: {}",
        error
    );
    let error = state
        .state
        .close_stage(id_a)
        .expect_err("double close fails readably");
    assert!(
        error.contains(&format!("no stage {}", id_a)),
        "got: {}",
        error
    );

    // B stays fully functional: tree, edit, undo.
    let sender_b = state.state.sender(id_b).expect("stage B lives");
    let tree = request_stage_tree(&sender_b).expect("B's tree still serializes");
    assert_eq!(tree[0].path, "/Prop");
    usdbee_lib::stage::request_set_variant_selection(&sender_b, "/Prop", "color", Some("blue"))
        .expect("editing stage B after A's close should succeed");
    assert!(
        usdbee_lib::stage::request_undo(&sender_b).expect("undo in B"),
        "B's undo journal survived A's close"
    );

    // Only B remains in the stage map.
    let stages = state.state.list_stages().expect("stage list");
    assert_eq!(stages.len(), 1, "only B remains: {stages:?}");
    assert_eq!(stages[0].stage_id, id_b);
}

#[test]
fn list_stages_reports_both_stages_with_dirty_counts() {
    let (state, _events) = common::owner_with_events();
    let id_a = state.open(&fixture("basic.usda")).stage_id;
    let id_b = state.open(&fixture("variants.usda")).stage_id;

    let stages = state.state.list_stages().expect("stage list");
    assert_eq!(stages.len(), 2, "both stages listed: {stages:?}");
    let a = stages
        .iter()
        .find(|s| s.stage_id == id_a)
        .expect("stage A listed");
    let b = stages
        .iter()
        .find(|s| s.stage_id == id_b)
        .expect("stage B listed");
    assert!(
        a.root_identifier.contains("basic.usda"),
        "A names its root: {}",
        a.root_identifier
    );
    assert!(
        b.root_identifier.contains("variants.usda"),
        "B names its root: {}",
        b.root_identifier
    );
    assert_eq!(a.dirty_count, 0, "A starts clean");
    assert_eq!(b.dirty_count, 0, "B starts clean");

    // An edit in A increments only A's dirty count.
    let sender_a = state.state.sender(id_a).expect("stage A lives");
    usdbee_lib::stage::request_set_attribute_value(
        &sender_a,
        "/World/Ball",
        "radius",
        &payload("float", serde_json::json!(9.5)),
        None,
    )
    .expect("editing stage A should succeed");

    let stages = state.state.list_stages().expect("stage list");
    let a = stages
        .iter()
        .find(|s| s.stage_id == id_a)
        .expect("stage A listed");
    let b = stages
        .iter()
        .find(|s| s.stage_id == id_b)
        .expect("stage B listed");
    assert_eq!(a.dirty_count, 1, "the edit dirtied A's session layer");
    assert_eq!(b.dirty_count, 0, "B stays clean");
}

#[test]
fn unknown_stage_ids_fail_readably_across_command_shapes() {
    let (state, _events) = common::owner_with_events();
    let id = state.open(&fixture("basic.usda")).stage_id;

    // Every stage-scoped command routes through the map lookup, so the
    // guard is one funnel: id 0 (never minted) and an arbitrary unknown id.
    for unknown in [0, 999] {
        let error = state.state.sender(unknown).expect_err("lookup must fail");
        assert!(
            error.contains(&format!("no stage {}", unknown)),
            "got: {}",
            error
        );
    }
    let error = state
        .state
        .close_stage(999)
        .expect_err("close guards the id");
    assert!(error.contains("no stage 999"), "got: {}", error);

    // A closed stage reads exactly like one that never existed.
    state.state.close_stage(id).expect("closing the only stage");
    let error = state
        .state
        .sender(id)
        .expect_err("commands against the closed id fail");
    assert!(
        error.contains(&format!("no stage {}", id)),
        "got: {}",
        error
    );
    assert!(state
        .state
        .close_stage(id)
        .unwrap_err()
        .contains(&format!("no stage {}", id)));
    // Closing the LAST stage is fine: the map is empty, not an error.
    assert!(
        state.state.list_stages().expect("list").is_empty(),
        "no stage remains after closing the last one"
    );
}
