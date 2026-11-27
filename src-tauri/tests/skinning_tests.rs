// Task 1 of UsdSkel skinning: fixture + pinned ground-truth positions.
// The constants come from `UsdSkel.BakeSkinning` over
// tests/fixtures/skinned.usda (usd-core), run at time codes 0 and 10.
// The skinning evaluation itself lives in `usdbee_lib::skinning`, wired
// into `tessellation::mesh_data`; these tests pin its output to the
// pxr-baked values.

use std::path::PathBuf;

use usdbee_lib::skinning::skin_mesh;
use usdbee_lib::stage::{open_stage, serialize_render_manifest, RenderNode};
use usdbee_lib::tessellation::{tessellate_prim, MeshData};

use openusd::sdf;
use openusd::usd::Prim;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

fn prim(stage: &openusd::usd::Stage, path: &str) -> Result<Prim, String> {
    let prim_path = sdf::try_into_path(path)
        .map_err(|e| format!("invalid test prim path '{}': {}", path, e))?;
    stage.prim(prim_path).map_err(|e| e.to_string())
}

fn tessellate(stage: &openusd::usd::Stage, path: &str, time: f64) -> MeshData {
    tessellate_prim(
        &prim(stage, path).expect("test prim should resolve"),
        Some(time),
    )
    .expect("tessellation should not fail for the tested prim")
    .expect("the tested prim is a Mesh")
}

fn assert_points_close(actual: &[[f32; 3]], expected: &[[f32; 3]]) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "vertex count changed between bind pose and ground truth"
    );
    for (vertex, (point, expected_point)) in actual.iter().zip(expected).enumerate() {
        for axis in 0..3 {
            assert!(
                (point[axis] - expected_point[axis]).abs() < 1e-4,
                "vertex {vertex} axis {axis}: expected {expected_point:?}, got {point:?}"
            );
        }
    }
}

// Ground truth from BakeSkinning, pasted verbatim from the generator
// output (float32 baked values).
const EXPECTED_DIRECT_T0: [[f32; 3]; 3] = [[2.0, 0.0, 0.0], [4.0, 0.0, 0.0], [4.0, 0.0, 0.0]];
const EXPECTED_DIRECT_T10: [[f32; 3]; 3] = [[2.0, 0.0, 0.0], [4.0, 0.0, 0.0], [4.0, 0.0, 1.0]];
const EXPECTED_OFFSET_T0: [[f32; 3]; 3] = [[-8.0, 0.0, 0.0], [-6.0, 0.0, 0.0], [-6.0, 0.0, 0.0]];
const EXPECTED_OFFSET_T10: [[f32; 3]; 3] =
    [[-8.0, 0.0, 0.0], [-6.0, 0.0, 0.0], [-7.0, -0.99999994, 1.0]];

// Rest pose of the animation-less Rig2 skeleton (BakeSkinning): the rest
// pose moves joint C from its bind (4,0,0) to (3,0,0), dragging vertex 2
// along; time-invariant.
const EXPECTED_REST: [[f32; 3]; 3] = [[2.0, 0.0, 0.0], [4.0, 0.0, 0.0], [3.0, 0.0, 0.0]];

// Hose_dual authors a mesh-side animation source (Other) that differs
// from the one authored on its Skeleton (Swing): the skeleton-side source
// wins (pxr precedence, OpenUSD#3532). BakeSkinning over the dual-authored
// fixture gives exactly Swing's motion — same constants as Hose_direct.
const EXPECTED_DUAL_SKELETON_SIDE_T0: [[f32; 3]; 3] =
    [[2.0, 0.0, 0.0], [4.0, 0.0, 0.0], [4.0, 0.0, 0.0]];
const EXPECTED_DUAL_SKELETON_SIDE_T10: [[f32; 3]; 3] =
    [[2.0, 0.0, 0.0], [4.0, 0.0, 0.0], [4.0, 0.0, 1.0]];

// Hose_norm (vertex-scoped authored normals) from BakeSkinning: the
// joints' rotation moves vertex 2 but the authored +Z normals stay +Z
// (Rz90 leaves the Z axis alone), so both time codes read the same.
const EXPECTED_NORM_T0_POINTS: [[f32; 3]; 3] = [[2.0, 0.0, 0.0], [4.0, 0.0, 0.0], [4.0, 1.0, 0.0]];
const EXPECTED_NORM_T10_POINTS: [[f32; 3]; 3] = [[2.0, 0.0, 0.0], [4.0, 0.0, 0.0], [3.0, 0.0, 1.0]];
const EXPECTED_NORM_SKINNED: [[f32; 3]; 3] = [[0.0, 0.0, 1.0], [0.0, 0.0, 1.0], [0.0, 0.0, 1.0]];

#[test]
fn skinning_mesh_points_follow_animated_skeleton() {
    let (stage, _info) = open_stage(&fixture("skinned.usda")).expect("skinned stage should open");

    // At t=0 the animation matches the bind pose, so the skinned points
    // equal the authored ones.
    let mesh = tessellate(&stage, "/Rig/Hose_direct", 0.0);
    assert_points_close(&mesh.positions, &EXPECTED_DIRECT_T0);

    // At t=10 joint C moved to (4,0,1) in skel space: vertex 2 (bound to C
    // at C's bind origin) is displaced by the animation.
    let mesh = tessellate(&stage, "/Rig/Hose_direct", 10.0);
    assert_points_close(&mesh.positions, &EXPECTED_DIRECT_T10);
}

#[test]
fn skinning_mesh_with_intermediate_xforms_maps_back_to_local() {
    let (stage, _info) = open_stage(&fixture("skinned.usda")).expect("skinned stage should open");

    // Hose_offset sits under Offset (T(10,0,0)) and carries its own
    // T(0,1,0) plus primvars:skel:geomBindTransform: skinned points must be
    // mapped back into the mesh's local space (the L^-1 mapping).
    let mesh = tessellate(&stage, "/Rig/Offset/Hose_offset", 0.0);
    assert_points_close(&mesh.positions, &EXPECTED_OFFSET_T0);

    // At t=10, C's local translate (2,0,1) plus rotZ90 displaces vertex 2
    // both along z and around it, in local space.
    let mesh = tessellate(&stage, "/Rig/Offset/Hose_offset", 10.0);
    assert_points_close(&mesh.positions, &EXPECTED_OFFSET_T10);
}

#[test]
fn binding_without_animation_source_uses_rest_pose() {
    let (stage, _info) = open_stage(&fixture("skinned.usda")).expect("skinned stage should open");

    // Rig2/SkelRest has no skel:animationSource, so the skeleton's
    // restTransforms pose the joints (rest C at (3,0,0) vs bind (4,0,0)).
    // The rest pose is time-invariant: both time codes agree.
    for time in [0.0, 10.0] {
        let mesh = tessellate(&stage, "/Rig2/Hose_rest", time);
        assert_points_close(&mesh.positions, &EXPECTED_REST);
    }
}

#[test]
fn skeleton_authored_animation_source_wins_over_mesh_inherited() {
    let (stage, _info) = open_stage(&fixture("skinned.usda")).expect("skinned stage should open");

    // Hose_dual authors BOTH sources: its own rel points at Other (which
    // at t=10 swings joint B to (0,5,0), dragging vertices to y=5), while
    // its skeleton /Rig/Skel points at Swing. The skeleton-side source
    // must win, so the baked points equal Swing's motion — not Other's.
    let mesh = tessellate(&stage, "/Rig/Hose_dual", 0.0);
    assert_points_close(&mesh.positions, &EXPECTED_DUAL_SKELETON_SIDE_T0);

    let mesh = tessellate(&stage, "/Rig/Hose_dual", 10.0);
    assert_points_close(&mesh.positions, &EXPECTED_DUAL_SKELETON_SIDE_T10);
}

#[test]
fn corrupt_weights_error_before_geometry_distorts() {
    let (stage, _info) = open_stage(&fixture("skinned.usda")).expect("skinned stage should open");

    // Hose_weighty authors [1, 1, 2]: lengths all line up, but vertex 2's
    // weight chunk is not normalized — silently it would double the
    // animated displacement. skin_mesh must refuse with a path-naming
    // error before either crate compute call.
    let weighty = prim(&stage, "/Rig/Hose_weighty").expect("test prim should resolve");
    let mut points = vec![
        openusd::gf::vec3f(2.0, 0.0, 0.0),
        openusd::gf::vec3f(4.0, 0.0, 0.0),
        openusd::gf::vec3f(4.0, 0.0, 0.0),
    ];
    let error = skin_mesh(&weighty, Some(10.0), &mut points, None)
        .expect_err("non-normalized weights must error, not distort");
    assert!(
        error.contains("Hose_weighty"),
        "error names the prim: {error}"
    );
    assert!(
        error.contains("jointWeights"),
        "error names the weights: {error}"
    );
    // Through tessellation the same corruption is fail-soft: unskinned.
    let mesh = tessellate(&stage, "/Rig/Hose_weighty", 10.0);
    assert_points_close(
        &mesh.positions,
        &[[2.0, 0.0, 0.0], [4.0, 0.0, 0.0], [4.0, 0.0, 0.0]],
    );
}

#[test]
fn vertex_scoped_authored_normals_are_skinned() {
    let (stage, _info) = open_stage(&fixture("skinned.usda")).expect("skinned stage should open");

    // Hose_norm authors vertex-scoped normals alongside skinned points:
    // both arrays must be evaluated (pxr-baked constants, above).
    let mesh = tessellate(&stage, "/Rig/Hose_norm", 0.0);
    assert_points_close(&mesh.positions, &EXPECTED_NORM_T0_POINTS);
    let normals = mesh.normals.expect("authored vertex normals survive");
    assert_points_close(&normals, &EXPECTED_NORM_SKINNED);

    let mesh = tessellate(&stage, "/Rig/Hose_norm", 10.0);
    assert_points_close(&mesh.positions, &EXPECTED_NORM_T10_POINTS);
    let normals = mesh.normals.expect("authored vertex normals survive");
    assert_points_close(&normals, &EXPECTED_NORM_SKINNED);
}

#[test]
fn non_vertex_authored_normals_are_replaced_by_generated_on_skinned_prims() {
    let (stage, _info) = open_stage(&fixture("skinned.usda")).expect("skinned stage should open");

    // Hose_fvn authors faceVarying normals this pass cannot skin; bind-pose
    // normals must never ship alongside skinned points, so they are dropped
    // and regenerated from the deformed positions — exactly the normals of
    // its identical twin with no authored normals at all.
    for time in [0.0, 10.0] {
        let mesh = tessellate(&stage, "/Rig/Hose_fvn", time);
        let twin = tessellate(&stage, "/Rig/Hose_fvn_twin", time);
        assert_points_close(&mesh.positions, &twin.positions);
        assert_eq!(
            mesh.normals, twin.normals,
            "non-vertex authored normals are regenerated, not shipped unskinned"
        );
    }
}

#[test]
fn rigid_binding_renders_unskinned_without_panic() {
    let (stage, _info) = open_stage(&fixture("skinned.usda")).expect("skinned stage should open");

    // Hose_rigid is constant-interpolation (one influence for the whole
    // prim): by scope decision it renders with its authored points, at
    // every time code, instead of being rigid-skinned.
    const AUTHORED: [[f32; 3]; 3] = [[1.0, 0.0, 0.0], [2.0, 0.0, 0.0], [1.0, 1.0, 0.0]];
    for time in [0.0, 10.0] {
        let mesh = tessellate(&stage, "/Rig/Hose_rigid", time);
        assert_points_close(&mesh.positions, &AUTHORED);
    }
}

#[test]
fn broken_influence_lengths_error() {
    let (stage, _info) = open_stage(&fixture("skinned.usda")).expect("skinned stage should open");

    // Hose_broken authors 2 jointIndices for 3 points: the crate's
    // skinning helpers would panic on the stride mismatch, so skin_mesh
    // must refuse first with a readable, path-naming error and leave the
    // input arrays untouched.
    let broken = prim(&stage, "/Rig/Hose_broken").expect("test prim should resolve");
    let authored = vec![
        openusd::gf::vec3f(0.0, 0.0, 0.0),
        openusd::gf::vec3f(1.0, 0.0, 0.0),
        openusd::gf::vec3f(0.0, 1.0, 0.0),
    ];
    let mut points = authored.clone();
    let error = skin_mesh(&broken, Some(0.0), &mut points, None)
        .expect_err("broken influences must error, not panic");
    assert!(
        error.contains("Hose_broken"),
        "error names the prim: {error}"
    );
    assert!(
        error.contains("jointIndices"),
        "error names the influence mismatch: {error}"
    );
    assert_eq!(points, authored, "failed skinning leaves points unskinned");

    // Through the tessellation path the same broken binding is fail-soft:
    // the mesh renders unskinned instead of being dropped.
    let mesh = tessellate(&stage, "/Rig/Hose_broken", 0.0);
    let expected: Vec<[f32; 3]> = authored.iter().map(|p| [p.x, p.y, p.z]).collect();
    assert_eq!(mesh.positions, expected);
}

// Task 3: the manifest flags skel-bound geometry whose animation source
// drives its points as geometry_animated, so playback refetches it.

fn find<'a>(nodes: &'a [RenderNode], path: &str) -> Option<&'a RenderNode> {
    nodes
        .iter()
        .find(|n| n.path == path)
        .or_else(|| nodes.iter().find_map(|n| find(&n.children, path)))
}

fn expect<'a>(nodes: &'a [RenderNode], path: &str) -> &'a RenderNode {
    find(nodes, path).unwrap_or_else(|| panic!("expected prim {} in manifest", path))
}

#[test]
fn skel_animated_mesh_is_geometry_animated() {
    let (stage, info) = open_stage(&fixture("skinned.usda")).expect("skinned stage should open");
    assert!(
        info.composition_errors.is_empty(),
        "composition errors: {:?}",
        info.composition_errors
    );
    let nodes = serialize_render_manifest(&stage, Some(0.0)).expect("manifest should serialize");

    // Skeleton-bound meshes under a time-varying animation source: the
    // playback step must refetch their geometry every frame.
    for path in [
        "/Rig/Hose_direct",
        "/Rig/Offset/Hose_offset",
        "/Rig/Hose_dual",
    ] {
        let node = expect(&nodes, path);
        assert!(node.geometry_animated, "{path} is skel-animated");
        assert!(node.animated, "{path} carries a motion signal");
    }

    // The rigid binding renders authored (unskinned) but is still
    // flagged: the over-flag is conservative, and a future rigid fix
    // must flip this assert.
    let rigid = expect(&nodes, "/Rig/Hose_rigid");
    assert!(
        rigid.geometry_animated,
        "rigid binding is over-flagged until rigid skinning is supported"
    );

    // A plain static mesh in the same rig stays unflagged.
    let plain = expect(&nodes, "/Rig/Plain");
    assert!(!plain.geometry_animated, "static mesh is not skel-animated");
    assert!(!plain.animated, "static mesh carries no motion signal");

    // A binding without an animation source poses at rest: its geometry
    // is load-time-stable even though it is skel-bound.
    let rest = expect(&nodes, "/Rig2/Hose_rest");
    assert!(
        !rest.geometry_animated,
        "skel-bound rest pose is not time-varying"
    );
    assert!(!rest.animated, "rest pose carries no motion signal");
}
