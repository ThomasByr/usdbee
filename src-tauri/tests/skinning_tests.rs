// Task 1 of UsdSkel skinning: fixture + pinned ground-truth positions.
// The constants come from `UsdSkel.BakeSkinning` over
// tests/fixtures/skinned.usda (usd-core), run at time codes 0 and 10.
// The skinning evaluation itself lives in `usdbee_lib::skinning`, wired
// into `tessellation::mesh_data`; these tests pin its output to the
// pxr-baked values.

use std::path::PathBuf;

use usdbee_lib::skinning::skin_mesh;
use usdbee_lib::stage::open_stage;
use usdbee_lib::tessellation::{tessellate_prim, MeshData};

use openusd::sdf;
use openusd::usd::Prim;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
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
