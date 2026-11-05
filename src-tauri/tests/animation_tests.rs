// Phase 2, Task 6: time codes end-to-end. The manifest's `animated` flags
// (own sampled geometry/xform attrs, plus ancestor xform sampling) and
// `get_geometry_data` time resolution — differing positions across times,
// equal counts, and linear interpolation at a non-integer time.

use std::path::PathBuf;

mod common;

use common::spawn_stage_owner;
use usdbee_lib::stage::{
    open_stage, request_animated_manifest, request_geometry_data, request_time_codes,
    serialize_animated_manifest, serialize_render_manifest, RenderNode,
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

fn delta_from(name: &str, time: Option<f64>) -> Vec<RenderNode> {
    let (stage, info) = open_stage(&fixture(name)).expect("stage should open");
    assert!(
        info.composition_errors.is_empty(),
        "composition errors: {:?}",
        info.composition_errors
    );
    serialize_animated_manifest(&stage, time).expect("delta manifest should serialize")
}

fn paths(nodes: &[RenderNode]) -> Vec<String> {
    let mut out: Vec<String> = nodes
        .iter()
        .map(|n| n.path.clone())
        .chain(nodes.iter().flat_map(|n| paths(&n.children)))
        .collect();
    out.sort();
    out
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

fn open_via_owner(state: &common::TestOwner, name: &str) {
    state.open(&fixture(name));
}

fn u32_le(bytes: &[u8], index: usize) -> u32 {
    u32::from_le_bytes(bytes[index..index + 4].try_into().unwrap())
}

fn f32_le(bytes: &[u8], index: usize) -> f32 {
    f32::from_le_bytes(bytes[index..index + 4].try_into().unwrap())
}

// --- time-delta manifest (playback path) -------------------------------

#[test]
fn delta_manifest_carries_exactly_the_time_dependent_prims() {
    let nodes = delta_from("animated.usda", Some(24.0));

    // /Scene has no own signal but animated descendants: a connector so
    // the frontend's instancing-context threading keeps its chain.
    let scene = expect(&nodes, "/Scene");
    assert!(!scene.animated, "connector root carries no own motion");

    // Pulse samples xformOp:translate — transform only, and the t=24
    // translation reads through to the local matrix.
    let pulse = expect(&nodes, "/Scene/Pulse");
    assert!(pulse.animated);
    assert!(!pulse.geometry_animated);
    assert_eq!(pulse.transform[12], 10.0, "sampled translate at t=24");

    // Wobble samples points: geometry refetch per step.
    let wobble = expect(&nodes, "/Scene/Wobble");
    assert!(wobble.animated);
    assert!(wobble.geometry_animated);

    // Mover samples its own translate.
    let mover = expect(&nodes, "/Scene/Mover");
    assert!(mover.animated);

    // Exactly the signal-bearing prims (plus connectors) — nothing else.
    assert_eq!(
        paths(&nodes),
        vec!["/Scene".to_string(), "/Scene/Mover".to_string(), "/Scene/Pulse".to_string(), "/Scene/Wobble".to_string()]
    );
}

#[test]
fn delta_manifest_skips_static_descendants_of_moving_prims() {
    let nodes = delta_from("animated.usda", Some(10.0));

    // Mover moves, but the frontend applies transforms as LOCAL matrices:
    // the static Child rides along through three.js parenting, so the
    // delta must not carry it (nor the fully static Still).
    assert!(find(&nodes, "/Scene/Mover/Child").is_none());
    assert!(find(&nodes, "/Scene/Still").is_none());
}

#[test]
fn delta_manifest_is_empty_for_a_static_stage() {
    let nodes = delta_from("basic.usda", Some(0.0));
    assert!(nodes.is_empty(), "expected an empty delta, got {:?}", paths(&nodes));
}

#[test]
fn delta_manifest_includes_sampled_visibility_prims() {
    // `visibility` with time samples flips the per-call `visible` flag —
    // samples_scene_motion never covered it, so the delta walk needs its
    // own signal (and the warm owner must re-sample it per time).
    let nodes = delta_from("sampled_visibility.usda", Some(1.0));
    let toggle = expect(&nodes, "/Scene/Toggle");
    assert!(!toggle.visible, "invisible at t=1");
    assert!(find(&nodes, "/Scene").is_some(), "connector root present");

    let nodes = delta_from("sampled_visibility.usda", Some(2.0));
    assert!(expect(&nodes, "/Scene/Toggle").visible, "visible at t=2");
}

#[test]
fn delta_manifest_resamples_visibility_through_the_owner() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "sampled_visibility.usda");

    let at_one = request_animated_manifest(&state.sender(), Some(1.0))
        .expect("delta at t=1 should serialize");
    assert!(!expect(&at_one, "/Scene/Toggle").visible);

    let at_two = request_animated_manifest(&state.sender(), Some(2.0))
        .expect("delta at t=2 should serialize");
    assert!(expect(&at_two, "/Scene/Toggle").visible);
}

#[test]
fn delta_manifest_rewrites_animated_instancer_instances() {
    // The instancer's positions carry time samples: the delta holds the
    // instancer plus its synthetic prototype child with per-time instance
    // matrices — and the whole prototype subtree when the child animates.
    let nodes = delta_from("animated_instancer.usda", Some(5.0));
    let swarm = expect(&nodes, "/Scene/Swarm");
    assert!(swarm.animated, "sampled positions flag the instancer");

    let proto = expect(&nodes, "/Scene/Swarm/__proto_0");
    assert!(proto.animated);
    assert_eq!(proto.instances.len(), 1);
    assert_eq!(proto.instances[0][12], 4.0, "t=5 position reads through");

    let nodes = delta_from("animated_instancer.usda", Some(1.0));
    assert_eq!(
        expect(&nodes, "/Scene/Swarm/__proto_0").instances[0][12],
        0.0,
        "t=1 position reads through"
    );
}

#[test]
fn delta_manifest_folds_each_prototype_roots_own_xform_into_instances() {
    // The prototype root's local xform multiplies into every instance
    // matrix, so a SAMPLED proto root animates its instances — the static
    // transform cache must not freeze it at its default-time value.
    let at_one = delta_from("proto_xform_motion.usda", Some(1.0));
    assert_eq!(
        expect(&at_one, "/Scene/Moving/__proto_0").instances[0][12],
        0.0,
        "proto root translate at t=1"
    );

    let at_two = delta_from("proto_xform_motion.usda", Some(2.0));
    assert_eq!(
        expect(&at_two, "/Scene/Moving/__proto_0").instances[0][12],
        5.0,
        "proto root translate at t=2"
    );

    // A static proto root's offset still lands in the matrices when the
    // value comes from the cache.
    for time in [Some(1.0), Some(2.0)] {
        let full = manifest_from("proto_xform_motion.usda", time);
        assert_eq!(
            expect(&full, "/Scene/Still/__proto_0").instances[0][13],
            3.0,
            "static proto root translate"
        );
    }
}

#[test]
fn delta_manifest_leaves_static_instancers_and_native_instances_alone() {
    // A static PointInstancer (no sampled arrays, static prototypes):
    // nothing under it changes per step, so nothing of it rides the delta.
    let nodes = delta_from("purpose_instancer.usda", Some(1.0));
    assert!(
        nodes.is_empty(),
        "static instancers stay off the delta, got {:?}",
        paths(&nodes)
    );

    // Native instances under a MOVING ancestor: the ancestor's local
    // matrix changes, the instance copies themselves are static — the
    // frontend's parenting carries them, so only the mover rides along.
    let nodes = delta_from("native_instances.usda", Some(2.0));
    let mover = expect(&nodes, "/Scene/Mover");
    assert_eq!(mover.transform[12], 2.0, "sampled translate at t=2");
    assert!(find(&nodes, "/Scene/AtRest").is_none());
    assert!(
        find(&nodes, "/Scene/Mover/InMotion").is_none(),
        "static native-instance copies follow the moving parent"
    );
}

#[test]
fn delta_manifest_emits_zero_instance_prototype_wrappers() {
    // Blocker 1: a delta-present instancer carries EVERY synthetic child
    // wrapper. A count dropping to zero must come through as a wrapper
    // with empty instances and visible=false (the frontend's hide
    // carrier) — for geometry-rooted AND Xform-rooted prototypes, whose
    // threaded descendants hide through the wrapper's three.js cascade.
    let nodes = delta_from("instancer_zero.usda", Some(1.0));
    assert_eq!(expect(&nodes, "/Scene/Geom/__proto_0").instances.len(), 1);
    let nest = expect(&nodes, "/Scene/Nest/__proto_0");
    assert_eq!(nest.instances.len(), 1);
    assert!(
        find(&nodes, "/Scene/Nest/__proto_0/Child").is_some(),
        "animated instancer keeps the full prototype subtree"
    );

    let nodes = delta_from("instancer_zero.usda", Some(5.0));
    let geom = expect(&nodes, "/Scene/Geom/__proto_0");
    assert!(geom.instances.is_empty(), "count dropped to zero at t=5");
    assert!(!geom.visible, "zero-instance wrapper is the hide carrier");
    let nest = expect(&nodes, "/Scene/Nest/__proto_0");
    assert!(nest.instances.is_empty());
    assert!(!nest.visible);
    assert!(
        nest.children.is_empty(),
        "hidden zero-instance wrapper carries no stale subtree"
    );
}

#[test]
fn delta_manifest_keeps_connector_subtrees_filtered() {
    // Blocker 1, the other side: a connector synthetic wrapper (the
    // instancer sits in the delta only because its prototype root samples
    // visibility) keeps its currently-drawn wrapper with a FILTERED subtree
    // — the static threaded child is absent BY DESIGN and must not be
    // hidden by the frontend's delta rule.
    let nodes = delta_from("instancer_zero.usda", Some(1.0));
    let conn = expect(&nodes, "/Scene/Conn/__proto_0");
    assert_eq!(conn.instances.len(), 1);
    assert!(!conn.visible, "prototype root invisible at t=1");
    assert!(
        find(&nodes, "/Scene/Conn/__proto_0/Child").is_none(),
        "static threaded descendants stay out of a connector delta"
    );

    let nodes = delta_from("instancer_zero.usda", Some(2.0));
    assert!(expect(&nodes, "/Scene/Conn/__proto_0").visible);
    assert!(find(&nodes, "/Scene/Conn/__proto_0/Child").is_none());
}

#[test]
fn delta_manifest_carries_descendants_of_visibility_sampled_ancestors() {
    // Blocker 2: the full walk bakes INHERITED computed visibility into
    // every node's visible flag, so static descendants of a
    // visibility-sampled ancestor must ride the delta with a freshly
    // computed flag — through plain chains, and lifted under an excluded
    // ancestor whose own visibility samples.
    let nodes = delta_from("vis_inherited.usda", Some(1.0));
    assert!(!expect(&nodes, "/Scene/Group").visible);
    assert!(!expect(&nodes, "/Scene/Group/Sub").visible);
    assert!(!expect(&nodes, "/Scene/Group/Sub/Leaf").visible);
    let lifted = expect(&nodes, "/Scene/Guide/GLeaf");
    assert!(!lifted.visible, "guide-lifted leaf inherits the flip");

    let nodes = delta_from("vis_inherited.usda", Some(2.0));
    assert!(expect(&nodes, "/Scene/Group").visible);
    assert!(expect(&nodes, "/Scene/Group/Sub").visible);
    assert!(expect(&nodes, "/Scene/Group/Sub/Leaf").visible);
    assert!(expect(&nodes, "/Scene/Guide/GLeaf").visible);
}

#[test]
fn delta_manifest_copies_native_proto_root_visibility() {
    // Blocker 3: USD evaluates a native prototype root's visibility
    // PER INSTANCE (the instance prim mirrors the samples; the prototype
    // root itself reports none), so the flip rides the delta through the
    // instance node's own flag and the copies must come along with flags
    // matching the full walk.
    let full = manifest_from("native_proto_vis.usda", Some(1.0));
    let nodes = delta_from("native_proto_vis.usda", Some(1.0));
    assert!(!expect(&nodes, "/Scene/I").visible, "instance flips invisible");
    let shape = expect(&nodes, "/Scene/I/Shape");
    assert_eq!(
        shape.visible,
        expect(&full, "/Scene/I/Shape").visible,
        "delta copy flags match the full walk"
    );

    let nodes = delta_from("native_proto_vis.usda", Some(2.0));
    assert!(expect(&nodes, "/Scene/I").visible);
    assert!(expect(&nodes, "/Scene/I/Shape").visible);
}

#[test]
fn delta_manifest_lifts_excluded_native_instance_copies() {
    // Blocker 4: an excluded native instance under a moving excluded
    // ancestor lifts its copies with the chain's transforms composed in —
    // force must thread so the copies ride with rebuilt local matrices.
    let nodes = delta_from("excluded_native.usda", Some(1.0));
    assert_eq!(expect(&nodes, "/Scene/Lift/I/WheelMesh").transform[12], 1.0);

    let nodes = delta_from("excluded_native.usda", Some(2.0));
    assert_eq!(
        expect(&nodes, "/Scene/Lift/I/WheelMesh").transform[12],
        2.0,
        "lifted copies carry the excluded ancestor's sampled translate"
    );
    assert!(find(&nodes, "/Scene/Lift").is_none(), "guide emits no node");
}

#[test]
fn delta_manifest_keeps_full_and_filtered_native_walks_apart() {
    // Blocker 5: the SAME native prototype is walked FILTERED for the
    // plain instance under Mover and FULL inside the animated instancer's
    // prototype subtree, in one delta request — the memo key must keep
    // the two walks apart or the full walk reuses the filtered entry and
    // drops the static copies.
    let nodes = delta_from("cross_mode.usda", Some(2.0));
    assert!(
        find(&nodes, "/Scene/Mover/I2/Static").is_none(),
        "filtered walk keeps the static copy out"
    );
    assert!(
        find(&nodes, "/Scene/Mover/I2/Wobble").is_some(),
        "filtered walk keeps the deforming copy"
    );
    assert!(
        find(&nodes, "/Scene/Inst/__proto_0/I1/Static").is_some(),
        "full walk inside the animated prototype keeps the static copy"
    );
    assert!(
        find(&nodes, "/Scene/Inst/__proto_0/I1/Wobble").is_some()
    );
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

    let at_start = request_geometry_data(&state.sender(), "/Scene/Wobble", Some(0.0))
        .expect("geometry at t=0 should pack");
    let at_end = request_geometry_data(&state.sender(), "/Scene/Wobble", Some(10.0))
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
    let bytes = request_geometry_data(&state.sender(), "/Scene/Wobble", Some(2.5))
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

#[test]
fn time_codes_union_every_animated_attribute() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");

    // Pulse's translate samples at 1 and 24; Wobble's points and Mover's
    // translate at 0 and 10 — one ascending union, no repeats.
    let codes = request_time_codes(&state.sender()).expect("time codes should serialize");
    assert_eq!(codes, vec![0.0, 1.0, 10.0, 24.0]);
}

#[test]
fn time_codes_empty_for_a_static_stage() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");

    let codes = request_time_codes(&state.sender()).expect("time codes should serialize");
    assert!(codes.is_empty(), "expected no time codes, got {:?}", codes);
}
