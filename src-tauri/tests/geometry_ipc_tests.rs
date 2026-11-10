use std::path::PathBuf;
use std::sync::Arc;

mod common;

use common::spawn_stage_owner;
use usdbee_lib::stage::{
    request_geometry_batch, request_geometry_data, request_scene_manifest, MeshCache, RenderNode,
};
use usdbee_lib::tessellation::{pack_geometry, MeshData};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn open_via_owner(state: &common::TestOwner, name: &str) {
    state.open(&fixture(name));
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

/// One packed geometry payload, the form the MeshCache stores now that a hit
/// must not re-pack.
fn stub_packed() -> Arc<[u8]> {
    pack_geometry(&stub_mesh()).into()
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
        request_geometry_data(&state.sender(), "/World/Ball", None).expect("geometry should pack");

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
    let manifest = request_scene_manifest(&state.sender(), None).expect("variant manifest");
    let shape = node(&manifest, "/Prop/Shape");
    assert_eq!(shape.type_name, "Sphere");
    assert!(shape.has_geometry);

    let bytes = request_geometry_data(&state.sender(), "/Prop/Shape", None)
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
    let manifest = request_scene_manifest(&state.sender(), None).expect("instance manifest");
    let shape = node(&manifest, "/Scene/WheelA/Wheel");
    assert_eq!(shape.type_name, "Sphere");
    assert!(shape.has_geometry);

    let bytes = request_geometry_data(&state.sender(), "/Scene/WheelA/Wheel", None)
        .expect("instanced sphere geometry should pack");
    assert!(u32_le(&bytes, 8) > 0);
    assert!(u32_le(&bytes, 12) > 0);
}

#[test]
fn geometry_for_nonexistent_prim_is_a_readable_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");

    let error = request_geometry_data(&state.sender(), "/World/Nope", None)
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

    let error = request_geometry_data(&state.sender(), "/World", None)
        .expect_err("an Xform must not produce geometry");
    assert!(
        error.contains("no geometry at /World"),
        "error says no geometry: {}",
        error
    );
}

#[test]
fn geometry_without_open_stage_fails() {
    // No stage open means id 0 — the lookup guards every command shape.
    let state = spawn_stage_owner();
    let error = state.state.sender(0).expect_err("no stage open must fail");
    assert_eq!(error, "no stage 0");
}

#[test]
fn batch_round_trip_frames_slots_fail_soft_per_path() {
    // One channel round trip: a good USDB frame, a missing prim and a
    // non-geometry prim each land as error slots without aborting the batch.
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");

    let bytes = request_geometry_batch(
        &state.sender(),
        &[
            "/World/Ball".to_string(),
            "/World/Nope".to_string(),
            "/World".to_string(),
        ],
        None,
    )
    .expect("batch should frame");

    assert_eq!(u32_le(&bytes, 0), 0x5553_4247, "batch magic 'USBG'");
    assert_eq!(u32_le(&bytes, 4), 1, "batch version 1");
    assert_eq!(u32_le(&bytes, 8), 3, "slot count");
    let mut offset: usize = 12;
    let slot = |bytes: &[u8], offset: &mut usize| -> (u32, Vec<u8>) {
        let status = u32_le(bytes, *offset);
        let len = u32_le(bytes, *offset + 4) as usize;
        let payload = bytes[*offset + 8..*offset + 8 + len].to_vec();
        *offset += 8 + ((len + 3) & !3);
        (status, payload)
    };

    let (status, payload) = slot(&bytes, &mut offset);
    assert_eq!(status, 0, "first slot: ok");
    assert_eq!(
        u32_le(&payload, 0),
        0x5553_4442,
        "slot bytes are a USDB frame"
    );
    assert_eq!(u32_le(&payload, 8), 3, "Ball vertex count");

    let (status, payload) = slot(&bytes, &mut offset);
    assert_eq!(status, 1, "missing prim: error slot");
    let error = String::from_utf8_lossy(&payload);
    assert!(
        error.contains("/World/Nope"),
        "error names the path: {}",
        error
    );

    let (status, payload) = slot(&bytes, &mut offset);
    assert_eq!(status, 1, "non-geometry prim: error slot");
    let error = String::from_utf8_lossy(&payload);
    assert!(
        error.contains("no geometry at /World"),
        "error says no geometry: {}",
        error
    );
    assert_eq!(offset, bytes.len(), "no trailing bytes");
}

#[test]
fn ok_slot_after_an_unaligned_error_slot_stays_aligned_and_decodes() {
    // I1: an error slot's UTF-8 message need not be a multiple of 4; frame_batch
    // pads payloads to 4 bytes so the next slot starts aligned and stays
    // decodable instead of throwing RangeError in the frontend decoder.
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");

    let bytes = request_geometry_batch(
        &state.sender(),
        &["/World/Nope".to_string(), "/World/Ball".to_string()],
        None,
    )
    .expect("batch should frame");

    let mut offset: usize = 12;
    let slot = |bytes: &[u8], offset: &mut usize| -> (u32, Vec<u8>, u32) {
        let start = *offset + 8;
        let status = u32_le(bytes, *offset);
        let len = u32_le(bytes, *offset + 4) as usize;
        let payload = bytes[*offset + 8..*offset + 8 + len].to_vec();
        *offset += 8 + ((len + 3) & !3);
        (status, payload, start as u32)
    };

    let (status, error_payload, _start) = slot(&bytes, &mut offset);
    assert_eq!(status, 1, "first slot: error from missing prim");
    let error = String::from_utf8_lossy(&error_payload);
    assert!(
        error.contains("/World/Nope"),
        "error names the path: {}",
        error
    );
    assert_ne!(
        error_payload.len() % 4,
        0,
        "error message length is not a multiple of 4"
    );

    let (status, payload, start) = slot(&bytes, &mut offset);
    assert_eq!(status, 0, "second slot: ok despite the preceding error");
    assert_eq!(
        start % 4,
        0,
        "ok slot payload starts at a 4-byte aligned offset"
    );
    assert_eq!(
        u32_le(&payload, 0),
        0x5553_4442,
        "slot bytes are a USDB frame"
    );
    assert_eq!(u32_le(&payload, 8), 3, "Ball vertex count");
    assert_eq!(offset, bytes.len(), "no trailing bytes");
}

#[test]
fn empty_batch_frames_zero_slots() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");

    let bytes = request_geometry_batch(&state.sender(), &[], None).expect("empty batch");

    assert_eq!(u32_le(&bytes, 0), 0x5553_4247);
    assert_eq!(u32_le(&bytes, 8), 0, "no slots");
    assert_eq!(bytes.len(), 12);
}

#[test]
fn batch_without_open_stage_fails() {
    // No stage open means id 0 — the lookup guards every command shape.
    let state = spawn_stage_owner();
    let error = state.state.sender(0).expect_err("no stage open must fail");
    assert_eq!(error, "no stage 0");
}

#[test]
fn two_instance_copies_of_one_prototype_tessellate_once_and_serve_warm() {
    // The dedup pin: two instance-proxy request paths of one prototype
    // resolve to the shared prototype prim, so one batch serves both slots
    // from a single tessellation, byte-equal — and a repeat batch serves
    // both from the MeshCache without any new tessellation.
    let state = spawn_stage_owner();
    open_via_owner(&state, "instanced.usda");
    assert_eq!(state.mesh_tessellations(), 0);

    let batch_paths = vec![
        "/Scene/WheelA/WheelMesh".to_string(),
        "/Scene/WheelB/WheelMesh".to_string(),
    ];
    let bytes =
        request_geometry_batch(&state.sender(), &batch_paths, None).expect("batch should frame");

    let slot_bytes = |bytes: &[u8], offset: &mut usize| -> (u32, Vec<u8>) {
        let status = u32_le(bytes, *offset);
        let len = u32_le(bytes, *offset + 4) as usize;
        let payload = bytes[*offset + 8..*offset + 8 + len].to_vec();
        *offset += 8 + len;
        (status, payload)
    };
    let mut offset = 12;
    let (first_status, first) = slot_bytes(&bytes, &mut offset);
    let (second_status, second) = slot_bytes(&bytes, &mut offset);
    assert_eq!(first_status, 0, "WheelA copy: ok");
    assert_eq!(second_status, 0, "WheelB copy: ok");
    assert_eq!(
        first, second,
        "both copies resolve to one prototype mesh: byte-identical"
    );
    assert_eq!(
        state.mesh_tessellations(),
        1,
        "one shared tessellation served both copies"
    );

    let repeat = request_geometry_batch(&state.sender(), &batch_paths, None).expect("repeat batch");
    assert_eq!(repeat, bytes, "repeat batch serves warm from the MeshCache");
    assert_eq!(
        state.mesh_tessellations(),
        1,
        "warm hits: no fresh tessellation"
    );

    // A single-path request of the same copy also hits the warm cache.
    let warm = request_geometry_data(&state.sender(), "/Scene/WheelA/WheelMesh", None)
        .expect("per-path refetch stays warm");
    assert_eq!(u32_le(&warm, 0), 0x5553_4442);
    assert_eq!(state.mesh_tessellations(), 1);
}

#[test]
fn manifest_matches_authored_hierarchy_transforms_and_flags() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");

    let manifest =
        request_scene_manifest(&state.sender(), None).expect("manifest should serialize");
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
fn mesh_cache_evicts_oldest_entries_instead_of_clearing() {
    // The old cache cleared itself at 2,048 entries, which threw away a whole
    // animation loop's tessellations (a bike loop needs 3,934 keys and every
    // step re-tessellated). Past that cap the map must stay warm.
    let mut cache = MeshCache::new();
    for i in 0..5000 {
        cache.insert(format!("/M{}", i), None, stub_packed());
    }
    assert_eq!(cache.len(), 5000, "no clear at the old 2,048-entry cap");
    assert!(cache.get("/M0", None).is_some(), "old keys stay");
    assert!(cache.get("/M4999", None).is_some());

    // Past the entry ceiling the OLDEST keys go one by one; a full clear
    // would leave exactly one entry behind.
    for i in 5000..8200 {
        cache.insert(format!("/M{}", i), None, stub_packed());
    }
    assert!(
        cache.len() > 2048,
        "eviction trims, it never empties the cache (len {})",
        cache.len()
    );
    assert!(
        cache.get("/M0", None).is_none(),
        "the oldest key is the one evicted"
    );
    assert!(cache.get("/M8199", None).is_some());
}
#[test]
fn mesh_cache_distinguishes_none_and_some_time_keys() {
    let mut cache = MeshCache::new();
    cache.insert("/M".into(), None, stub_packed());
    assert!(cache.get("/M", Some(1.0)).is_none());
    assert!(cache.get("/M", None).is_some());
}

#[test]
fn mesh_cache_clear_empties_everything() {
    // The stage owner clears on every Open; this pins the clear semantics.
    let mut cache = MeshCache::new();
    cache.insert("/M".into(), None, stub_packed());
    cache.clear();
    assert_eq!(cache.len(), 0);
    assert!(cache.get("/M", None).is_none());
}

#[test]
fn mesh_cache_refresh_of_capped_entry_does_not_clear() {
    let mut cache = MeshCache::new();
    for i in 0..256 {
        cache.insert(format!("/M{}", i), None, stub_packed());
    }
    cache.insert("/M0".into(), None, stub_packed());
    assert_eq!(
        cache.len(),
        256,
        "re-inserting an existing key is a refresh"
    );
    assert!(cache.get("/M255", None).is_some());
}
