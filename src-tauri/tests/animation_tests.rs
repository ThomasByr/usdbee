// Phase 2, Task 6: time codes end-to-end. The manifest's `animated` flags
// (own sampled geometry/xform attrs, plus ancestor xform sampling) and
// `get_geometry_data` time resolution — differing positions across times,
// equal counts, and linear interpolation at a non-integer time.

use std::path::PathBuf;
use std::sync::mpsc;

use usdbee_lib::stage::{
    open_stage, request_geometry_data, serialize_render_manifest, spawn_stage_owner, RenderNode,
    StageState,
};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn manifest_at(time: Option<f64>) -> Vec<RenderNode> {
    manifest_from("animated.usda", time)
}

fn manifest_from(name: &str, time: Option<f64>) -> Vec<RenderNode> {
    let (stage, info) = open_stage(&fixture(name)).expect("stage should open");
    assert!(
        info.composition_errors.is_empty(),
        "composition errors: {:?}",
        info.composition_errors
    );
    serialize_render_manifest(&stage, time).expect("manifest should serialize")
}

fn find<'a>(nodes: &'a [RenderNode], path: &str) -> Option<&'a RenderNode> {
    nodes
        .iter()
        .find(|n| n.path == path)
        .or_else(|| nodes.iter().find_map(|n| find(&n.children, path)))
}

fn expect<'a>(nodes: &'a [RenderNode], path: &str) -> &'a RenderNode {
    find(nodes, path).unwrap_or_else(|| panic!("expected prim {} in manifest", path))
}

fn open_via_owner(state: &StageState, name: &str) {
    let (reply_tx, reply_rx) = mpsc::channel();
    state
        .sender
        .send(usdbee_lib::stage::StageRequest::Open {
            path: fixture(name),
            is_usdz: false,
            source_usdz: None,
            reply: reply_tx,
        })
        .expect("stage owner should accept an open request");
    reply_rx
        .recv()
        .expect("stage owner should reply")
        .expect("stage should open");
}

fn u32_le(bytes: &[u8], index: usize) -> u32 {
    u32::from_le_bytes(bytes[index..index + 4].try_into().unwrap())
}

fn f32_le(bytes: &[u8], index: usize) -> f32 {
    f32::from_le_bytes(bytes[index..index + 4].try_into().unwrap())
}

// The packed payload's positions start right after the 20-byte header;
// vertex i sits at 20 + i * 12 + axis * 4.
fn position(bytes: &[u8], vertex: usize, axis: usize) -> f32 {
    f32_le(bytes, 20 + vertex * 12 + axis * 4)
}

fn vertex_count(bytes: &[u8]) -> usize {
    u32_le(bytes, 8) as usize
}

#[test]
fn manifest_flags_own_geometry_and_xform_sampling() {
    let nodes = manifest_at(Some(0.0));

    // /Scene itself authors no sampled attrs.
    let scene = expect(&nodes, "/Scene");
    assert!(!scene.animated, "static Xform root must not be flagged");

    // Pulse authors xformOp:translate timeSamples.
    let pulse = expect(&nodes, "/Scene/Pulse");
    assert!(pulse.animated, "sampled xformOps flag the prim");

    // Wobble's points are sampled -> deforming geometry.
    let wobble = expect(&nodes, "/Scene/Wobble");
    assert!(wobble.animated, "sampled points flag the prim");
    assert!(wobble.has_geometry);

    // Still authors only default-time values.
    let still = expect(&nodes, "/Scene/Still");
    assert!(
        !still.animated,
        "a static sibling with no time samples must not be flagged"
    );
}

#[test]
fn manifest_separates_geometry_deformation_from_transform_motion() {
    let nodes = manifest_at(Some(0.0));

    // Wobble's points are time-sampled: its own geometry deforms, so a
    // playback step must refetch it.
    let wobble = expect(&nodes, "/Scene/Wobble");
    assert!(wobble.animated);
    assert!(
        wobble.geometry_animated,
        "sampled points imply geometry_animated"
    );

    // Pulse samples only xformOp:translate (its custom `size` samples are
    // unrendered data): transforms per step, but geometry never changes.
    let pulse = expect(&nodes, "/Scene/Pulse");
    assert!(pulse.animated);
    assert!(
        !pulse.geometry_animated,
        "sampled xformOps alone do not deform geometry"
    );

    // The Child mesh is static under a sampled-ancestor Xform: it animates
    // (its transform changes per step) but its geometry is load-time-stable.
    let child = expect(&nodes, "/Scene/Mover/Child");
    assert!(child.animated);
    assert!(
        !child.geometry_animated,
        "ancestor transform motion never deforms the child's geometry"
    );

    let still = expect(&nodes, "/Scene/Still");
    assert!(!still.animated);
    assert!(!still.geometry_animated);
}

#[test]
fn manifest_flags_sampled_topology_under_transform_motion() {
    let nodes = manifest_from("sampled_topology.usda", Some(0.0));

    // Static points, time-sampled face indices/counts, under a sampled
    // ancestor Xform: tessellation reads the topology at the requested
    // time, so the playback step must refetch this mesh.
    let topo = expect(&nodes, "/Scene/Metamorph/Topo");
    assert!(topo.animated, "ancestor transform motion flags the prim");
    assert!(
        topo.geometry_animated,
        "time-sampled topology is geometry-defining"
    );
}

#[test]
fn manifest_flags_children_of_an_animated_xform() {
    let nodes = manifest_at(Some(0.0));

    // USD semantics pinned: a prim under a moving Xform moves with the
    // parent, so the ancestor's xformOp time samples propagate the flag
    // down the walk even though the child itself is fully static.
    let mover = expect(&nodes, "/Scene/Mover");
    assert!(mover.animated, "sampled xformOps flag the prim");

    let child = expect(&nodes, "/Scene/Mover/Child");
    assert!(
        child.animated,
        "a static child under an animated xform must be flagged"
    );
    assert!(child.has_geometry);
}

#[test]
fn geometry_positions_differ_by_time_with_equal_counts() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");

    let at_start = request_geometry_data(&state.sender, "/Scene/Wobble", Some(0.0))
        .expect("geometry at t=0 should pack");
    let at_end = request_geometry_data(&state.sender, "/Scene/Wobble", Some(10.0))
        .expect("geometry at t=10 should pack");

    assert_eq!(vertex_count(&at_start), 3);
    assert_eq!(
        vertex_count(&at_end),
        vertex_count(&at_start),
        "vertex counts stay equal across time"
    );
    assert_eq!(
        position(&at_end, 1, 0),
        2.0,
        "authored points at t=10 read through"
    );
    assert!(
        position(&at_start, 1, 0) != position(&at_end, 1, 0),
        "positions differ between t=0 and t=10"
    );
}

#[test]
fn geometry_interpolates_linearly_at_non_integer_time() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");

    // points sampled at t=0 (x=1) and t=10 (x=2): reading at t=2.5 must
    // resolve to the linear interpolation, one quarter of the way.
    let bytes = request_geometry_data(&state.sender, "/Scene/Wobble", Some(2.5))
        .expect("geometry at t=2.5 should pack");
    assert_eq!(vertex_count(&bytes), 3, "interpolation keeps the counts");
    assert!(
        (position(&bytes, 1, 0) - 1.25).abs() < 1e-6,
        "linear interpolation at t=2.5, got {}",
        position(&bytes, 1, 0)
    );
    assert!(
        (position(&bytes, 2, 1) - 1.25).abs() < 1e-6,
        "linear interpolation on the second axis, got {}",
        position(&bytes, 2, 1)
    );
}
