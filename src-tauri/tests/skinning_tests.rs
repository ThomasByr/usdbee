// Task 1 of UsdSkel skinning: fixture + pinned ground-truth positions.
// The constants come from `UsdSkel.BakeSkinning` over
// tests/fixtures/skinned.usda (usd-core), run at time codes 0 and 10.
// The skinning implementation is a later task, so until then these tests
// are EXPECTED to fail: tessellation returns the authored bind-pose points.

use std::path::PathBuf;

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
