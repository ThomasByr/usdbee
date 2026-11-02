use std::path::PathBuf;
use std::sync::Arc;

use usdbee_lib::stage::{
    request_geometry_data, request_scene_manifest, spawn_stage_owner, MeshCache, RenderNode,
    StageState,
};
use usdbee_lib::tessellation::{pack_geometry, MeshData};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn open_via_owner(state: &StageState, name: &str) {
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state
        .sender
        .send(usdbee_lib::stage::StageRequest::Open {
            path: fixture(name),
            reply: reply_tx,
        })
        .expect("stage owner should accept an open request");
    reply_rx
        .recv()
        .expect("stage owner should reply")
        .expect("stage should open");
}

fn find_node<'a>(nodes: &'a [RenderNode], path: &str) -> Option<&'a RenderNode> {
    nodes
        .iter()
        .find(|n| n.path == path)
        .or_else(|| nodes.iter().find_map(|n| find_node(&n.children, path)))
}

fn node<'a>(nodes: &'a [RenderNode], path: &str) -> &'a RenderNode {
    find_node(nodes, path)
        .unwrap_or_else(|| panic!("expected prim {} in manifest {:?}", path, nodes))
}

fn u32_le(bytes: &[u8], index: usize) -> u32 {
    u32::from_le_bytes(bytes[index..index + 4].try_into().unwrap())
}

fn f32_le(bytes: &[u8], index: usize) -> f32 {
    f32::from_le_bytes(bytes[index..index + 4].try_into().unwrap())
}

fn stub_mesh() -> Arc<MeshData> {
    Arc::new(MeshData {
        positions: vec![[0.0, 0.0, 0.0]],
        normals: None,
        uvs: None,
        colors: None,
        indices: vec![0],
    })
}

#[test]
fn pack_geometry_lays_out_header_and_sections() {
    let mesh = MeshData {
        positions: vec![[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        normals: Some(vec![[0.0, 0.0, 1.0]; 3]),
        uvs: None,
        colors: Some(vec![[0.5, 0.5, 0.5]; 3]),
        indices: vec![0, 1, 2],
    };
    let bytes = pack_geometry(&mesh);

    assert_eq!(u32_le(&bytes, 0), 0x5553_4442, "magic 'USDB'");
    assert_eq!(u32_le(&bytes, 4), 1, "version 1");
    assert_eq!(u32_le(&bytes, 8), 3, "vertex_count");
    assert_eq!(u32_le(&bytes, 12), 3, "index_count");
    assert_eq!(
        u32_le(&bytes, 16),
        0b101,
        "bit0 normals, bit2 colors, no uvs"
    );
    assert_eq!(bytes.len(), 20 + 3 * 12 + 3 * 12 + 3 * 12 + 3 * 4);

    // positions first
    assert_eq!(f32_le(&bytes, 20), -1.0);
    assert_eq!(f32_le(&bytes, 28), 0.0);
    // normals second (start at 20 + 36): first normal's z at +8
    assert_eq!(f32_le(&bytes, 64), 1.0);
    // colors third (start at 20 + 72), then indices at 20 + 108
    assert_eq!(f32_le(&bytes, 92), 0.5);
    assert_eq!(u32_le(&bytes, 128), 0);
    assert_eq!(u32_le(&bytes, 136), 2);
}

#[test]
fn geometry_round_trip_via_owner_matches_task1_golden_values() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");

    let bytes =
        request_geometry_data(&state.sender, "/World/Ball", None).expect("geometry should pack");

    assert_eq!(u32_le(&bytes, 0), 0x5553_4442);
    assert_eq!(u32_le(&bytes, 4), 1);
    assert_eq!(u32_le(&bytes, 8), 3, "Task 1 golden: 3 vertices");
    assert_eq!(u32_le(&bytes, 12), 3, "Task 1 golden: one triangle");
    assert_eq!(
        u32_le(&bytes, 16),
        0b101,
        "generated normals + authored displayColor, no uvs"
    );
    assert_eq!(f32_le(&bytes, 20), -1.0, "first position x");
    assert_eq!(f32_le(&bytes, 28), 0.0, "first position z");
}

#[test]
fn variants_sphere_is_renderable_end_to_end_with_red_vertex_colors() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "variants.usda");
    let manifest = request_scene_manifest(&state.sender, None).expect("variant manifest");
    let shape = node(&manifest, "/Prop/Shape");
    assert_eq!(shape.type_name, "Sphere");
    assert!(shape.has_geometry);

    let bytes = request_geometry_data(&state.sender, "/Prop/Shape", None)
        .expect("sphere geometry should pack");
    let vertices = u32_le(&bytes, 8) as usize;
    assert!(vertices > 0);
    assert!(u32_le(&bytes, 12) > 0);
    assert_eq!(u32_le(&bytes, 16) & 0b100, 0b100);
    let colors = 20 + vertices * 32;
    assert_eq!(f32_le(&bytes, colors), 1.0);
    assert_eq!(f32_le(&bytes, colors + 4), 0.0);
    assert_eq!(f32_le(&bytes, colors + 8), 0.0);
}

#[test]
fn native_instance_sphere_is_renderable_end_to_end() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "instanced.usda");
    let manifest = request_scene_manifest(&state.sender, None).expect("instance manifest");
    let shape = node(&manifest, "/Scene/WheelA/Wheel");
    assert_eq!(shape.type_name, "Sphere");
    assert!(shape.has_geometry);

    let bytes = request_geometry_data(&state.sender, "/Scene/WheelA/Wheel", None)
        .expect("instanced sphere geometry should pack");
    assert!(u32_le(&bytes, 8) > 0);
    assert!(u32_le(&bytes, 12) > 0);
}

#[test]
fn geometry_for_nonexistent_prim_is_a_readable_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");

    let error = request_geometry_data(&state.sender, "/World/Nope", None)
        .expect_err("missing prim must not succeed");
    assert!(
        error.contains("/World/Nope"),
        "error names the path: {}",
        error
    );
}

#[test]
fn geometry_for_non_mesh_prim_is_a_readable_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");

    let error = request_geometry_data(&state.sender, "/World", None)
        .expect_err("an Xform must not produce geometry");
    assert!(
        error.contains("no geometry at /World"),
        "error says no geometry: {}",
        error
    );
}

#[test]
fn geometry_without_open_stage_fails() {
    let state = spawn_stage_owner();
    let error = request_geometry_data(&state.sender, "/World/Ball", None)
        .expect_err("no stage open must fail");
    assert_eq!(error, "no stage open");
}

#[test]
fn manifest_matches_authored_hierarchy_transforms_and_flags() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");

    let manifest = request_scene_manifest(&state.sender, None).expect("manifest should serialize");
    assert_eq!(manifest.len(), 1);

    let world = &manifest[0];
    assert_eq!(world.path, "/World");
    assert_eq!(world.name, "World");
    assert_eq!(world.type_name, "Xform");
    assert!(!world.has_geometry);
    assert!(world.visible);
    assert!(!world.animated);
    assert_eq!(world.material, None);
    assert!(world.instances.is_empty());
    // Row-major row-vector convention (values.rs): translation lands in the
    // last row of the 4x4, i.e. components 12..14 of the [f64; 16].
    assert_eq!(world.transform[12], 1.0);
    assert_eq!(world.transform[13], 2.0);
    assert_eq!(world.transform[14], 3.0);

    assert_eq!(world.children.len(), 2);
    let ground = node(&world.children, "/World/Ground");
    assert!(!ground.has_geometry);
    assert_eq!(ground.transform[14], -1.0);

    let ball = node(&world.children, "/World/Ball");
    assert_eq!(ball.type_name, "Mesh");
    assert!(ball.has_geometry, "Mesh prims report geometry");
    // No xformOpOrder on Ball: identity transform.
    assert_eq!(
        ball.transform,
        [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
    );
}

#[test]
fn mesh_cache_caps_at_256_by_clearing() {
    let mut cache = MeshCache::new();
    for i in 0..256 {
        cache.insert((format!("/M{}", i), None), stub_mesh());
    }
    assert_eq!(cache.len(), 256);
    assert!(cache.get(&("/M0".into(), None)).is_some());

    // shortcut: 257th distinct insert clears everything, keeps just the new entry
    cache.insert(("/M256".into(), None), stub_mesh());
    assert_eq!(cache.len(), 1);
    assert!(cache.get(&("/M256".into(), None)).is_some());
    assert!(cache.get(&("/M0".into(), None)).is_none());
}

#[test]
fn mesh_cache_distinguishes_none_and_some_time_keys() {
    let mut cache = MeshCache::new();
    cache.insert(("/M".into(), None), stub_mesh());
    assert!(cache.get(&("/M".into(), Some(1.0))).is_none());
    assert!(cache.get(&("/M".into(), None)).is_some());
}

#[test]
fn mesh_cache_clear_empties_everything() {
    // The stage owner clears on every Open; this pins the clear semantics.
    let mut cache = MeshCache::new();
    cache.insert(("/M".into(), None), stub_mesh());
    cache.clear();
    assert_eq!(cache.len(), 0);
    assert!(cache.get(&("/M".into(), None)).is_none());
}

#[test]
fn mesh_cache_refresh_of_capped_entry_does_not_clear() {
    let mut cache = MeshCache::new();
    for i in 0..256 {
        cache.insert((format!("/M{}", i), None), stub_mesh());
    }
    cache.insert(("/M0".into(), None), stub_mesh());
    assert_eq!(
        cache.len(),
        256,
        "re-inserting an existing key is a refresh"
    );
    assert!(cache.get(&("/M255".into(), None)).is_some());
}
