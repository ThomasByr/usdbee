mod common;

use usdbee_lib::stage::request_list_dirty_layers;

use common::{
    attribute, details_via_owner, fixture, open_path_via_owner, open_via_owner, owner_with_events,
    request_redo, request_undo, spawn_stage_owner, undo_state, TestOwner,
};

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
