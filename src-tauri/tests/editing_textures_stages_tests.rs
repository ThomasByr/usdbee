use std::path::PathBuf;

mod common;

use usdbee_lib::stage::{request_list_dirty_layers, request_stage_tree};

use common::{
    fixture, open_via_owner, owner_with_events, payload, request_redo, request_undo, undo_state,
    TestOwner,
};

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
