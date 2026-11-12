mod common;

use usdbee_lib::stage::{
    request_list_dirty_layers, request_save_layers, request_set_edit_target, LayerSaveRequest,
};

use common::{
    attribute, details_via_owner, edit_target, fixture, open_path_via_owner, open_via_owner,
    owner_with_events, payload, request_set_value, request_undo, spawn_stage_owner, undo_state,
};

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
    request_set_edit_target(&state.sender(), Some(&info.root_layer))
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
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
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

    let error = request_set_edit_target(&state.sender(), Some("/nope/missing.usda"))
        .expect_err("an unknown layer must be rejected");
    assert!(error.contains("missing.usda"), "got: {}", error);

    // None means the session layer, which exists here: it must succeed.
    request_set_edit_target(&state.sender(), None).expect("None selects the session layer");
}

#[test]
fn set_edit_target_without_open_stage_fails() {
    let state = spawn_stage_owner();
    // set_edit_target and list_dirty_layers both resolve their stage by id
    // before anything else, so the lookup guard is their shared refusal.
    let error = state.state.sender(0).expect_err("no stage is open");
    assert!(error.contains("no stage 0"), "got: {}", error);
}

#[test]
fn failed_open_preserves_dirty_and_undo_state_for_the_current_stage() {
    let (state, _events) = owner_with_events();
    open_via_owner(&state, "basic.usda");
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("edit should succeed");
    assert_eq!(
        request_list_dirty_layers(&state.sender())
            .expect("dirty layers")
            .len(),
        1
    );
    assert!(undo_state(&state).can_undo);

    let missing = fixture("does-not-exist.usda");
    state.try_open(&missing).expect_err("open must fail");
    // The failed open removed the entry it created: only the edited stage
    // remains in the map.
    assert_eq!(
        state.state.list_stages().expect("stage list").len(),
        1,
        "the failed open leaves no map entry"
    );

    assert_eq!(
        request_list_dirty_layers(&state.sender())
            .expect("dirty layers after failed open")
            .len(),
        1,
        "the old stage's unsaved edit stays visible"
    );
    assert!(
        undo_state(&state).can_undo,
        "the old stage's undo journal stays coherent"
    );
    assert!(request_undo(&state).expect("undo still works after failed open"));
    assert_eq!(
        attribute(&details_via_owner(&state, "/World/Ball", None), "radius")
            .value
            .data,
        serde_json::json!(1.0)
    );
    assert!(request_list_dirty_layers(&state.sender())
        .expect("dirty layers after undo")
        .is_empty());
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

    request_set_edit_target(&state.sender(), Some(&info.root_layer)).expect("switch to root");
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
        &state.sender(),
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
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
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
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    let session = dirty.iter().find(|l| l.is_session).expect("session entry");

    // Same-as-root path: refused (it would overwrite the root layer file).
    let error = request_save_layers(
        &state.sender(),
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
        &state.sender(),
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
        &state.sender(),
        &[LayerSaveRequest {
            identifier: session.identifier.clone(),
            path: path.to_string_lossy().to_string(),
        }],
    )
    .expect("saving the session layer to a new usda path should succeed");
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert!(
        dirty.is_empty(),
        "the session layer is clean after save: {:?}",
        dirty
    );
}

#[test]
fn save_layers_rejects_session_over_referenced_and_payload_layers() {
    for root_name in ["scene_with_ref.usda", "payload.usda"] {
        let (state, _events) = owner_with_events();
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join(root_name);
        let asset = dir.path().join("asset.usda");
        std::fs::copy(fixture(root_name), &root).expect("copy root fixture");
        std::fs::copy(fixture("asset.usda"), &asset).expect("copy referenced fixture");
        open_path_via_owner(&state, &root);
        let prim = if root_name == "scene_with_ref.usda" {
            "/Scene/Car/Wheel"
        } else {
            "/Scene/Heavy/Wheel"
        };
        request_set_value(
            &state,
            prim,
            "radius",
            payload("double", serde_json::json!(2.0)),
            None,
        )
        .expect("session edit should succeed");
        let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers");
        let session = dirty
            .iter()
            .find(|layer| layer.is_session)
            .expect("session layer");
        let before = std::fs::read(&asset).expect("referenced layer bytes");

        let error = request_save_layers(
            &state.sender(),
            &[LayerSaveRequest {
                identifier: session.identifier.clone(),
                path: asset.to_string_lossy().to_string(),
            }],
        )
        .expect_err("a composed referenced/payload layer must be protected");

        assert!(error.contains("asset.usda"), "got: {error}");
        assert_eq!(
            std::fs::read(&asset).expect("referenced layer re-read"),
            before
        );
    }
}

#[test]
fn save_layers_rejects_normalized_aliases_of_composed_layers() {
    let (state, _events) = owner_with_events();
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path().join("basic.usda");
    std::fs::copy(fixture("basic.usda"), &root).expect("copy root fixture");
    std::fs::create_dir(dir.path().join("nested")).expect("alias directory");
    open_path_via_owner(&state, &root);
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("session edit should succeed");
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers");
    let session = dirty
        .iter()
        .find(|layer| layer.is_session)
        .expect("session layer");
    let alias = dir.path().join("nested").join("..").join("basic.usda");
    let before = std::fs::read(&root).expect("root bytes");

    let error = request_save_layers(
        &state.sender(),
        &[LayerSaveRequest {
            identifier: session.identifier.clone(),
            path: alias.to_string_lossy().to_string(),
        }],
    )
    .expect_err("dot-dot aliases must not bypass source protection");

    assert!(error.contains("basic.usda"), "got: {error}");
    assert_eq!(std::fs::read(&root).expect("root re-read"), before);
}

#[cfg(unix)]
#[test]
fn save_layers_rejects_symlink_aliases_of_composed_layers() {
    let (state, _events) = owner_with_events();
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path().join("basic.usda");
    let alias = dir.path().join("alias.usda");
    std::fs::copy(fixture("basic.usda"), &root).expect("copy root fixture");
    std::os::unix::fs::symlink(&root, &alias).expect("symlink");
    open_path_via_owner(&state, &root);
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("session edit should succeed");
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers");
    let session = dirty
        .iter()
        .find(|layer| layer.is_session)
        .expect("session layer");
    let before = std::fs::read(&root).expect("root bytes");

    request_save_layers(
        &state.sender(),
        &[LayerSaveRequest {
            identifier: session.identifier.clone(),
            path: alias.to_string_lossy().to_string(),
        }],
    )
    .expect_err("symlink aliases must not bypass source protection");

    assert_eq!(std::fs::read(&root).expect("root re-read"), before);
}

#[test]
fn save_layers_rejects_duplicate_destinations_before_writing() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(1.5)),
        None,
    )
    .expect("session edit should succeed");
    request_set_edit_target(&state.sender(), Some(&info.root_layer)).expect("switch to root");
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("root edit should succeed");
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers");
    let session = dirty
        .iter()
        .find(|layer| layer.is_session)
        .expect("session layer");
    let dir = tempfile::tempdir().expect("temp dir");
    let destination = dir.path().join("shared.usda");

    let error = request_save_layers(
        &state.sender(),
        &[
            LayerSaveRequest {
                identifier: info.root_layer.clone(),
                path: destination.to_string_lossy().to_string(),
            },
            LayerSaveRequest {
                identifier: session.identifier.clone(),
                path: destination.to_string_lossy().to_string(),
            },
        ],
    )
    .expect_err("two layers must not overwrite one destination");

    assert!(error.contains("destination"), "got: {error}");
    assert!(!destination.exists(), "validation runs before any write");
    assert_eq!(
        request_list_dirty_layers(&state.sender())
            .expect("dirty layers")
            .len(),
        2
    );
}

#[test]
fn save_layers_enforces_the_extension_whitelist() {
    let (state, _events) = owner_with_events();
    let info = open_path_via_owner(&state, &fixture("basic.usda"));

    request_set_edit_target(&state.sender(), Some(&info.root_layer)).expect("switch to root");
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("root edit should succeed");

    let error = request_save_layers(
        &state.sender(),
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
            &state.sender(),
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
    request_set_edit_target(&state.sender(), Some(&sub_identifier))
        .expect("switching to the sublayer should succeed");

    request_set_value(
        &state,
        "/Scene/Sub",
        "radius",
        payload("double", serde_json::json!(1.5)),
        None,
    )
    .expect("sublayer edit should succeed");

    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(dirty.len(), 1, "only the sublayer is dirty: {:?}", dirty);
    assert!(!dirty[0].is_session);
    assert_eq!(dirty[0].identifier, sub_identifier);

    // The composed value reads back through the sublayer opinion.
    let details = details_via_owner(&state, "/Scene/Sub", None);
    let radius = attribute(&details, "radius");
    assert_eq!(radius.value.data, serde_json::json!(1.5));
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
    request_set_edit_target(&state.sender(), Some(&info.root_layer)).expect("switch to root");
    request_set_value(
        &state,
        "/World/Ball",
        "radius",
        payload("float", serde_json::json!(2.5)),
        None,
    )
    .expect("root edit should succeed");
    let dirty_before = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert_eq!(dirty_before.len(), 2, "both layers start dirty");

    // First request is valid, second fails validation: nothing may be
    // written and the dirty state must stay untouched.
    let dir = tempfile::tempdir().expect("temp dir");
    let first = dir.path().join("first.usda");
    let error = request_save_layers(
        &state.sender(),
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
    let dirty_after = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
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
        &state.sender(),
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
    let dirty = request_list_dirty_layers(&state.sender()).expect("dirty layers list");
    assert!(dirty.is_empty(), "both layers are clean: {:?}", dirty);
}
