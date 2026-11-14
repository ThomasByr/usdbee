mod common;

use common::{attribute, fixture, spawn_stage_owner};
use serde_json::json;
use usdbee_lib::stage::{request_stage_details, request_stage_tree, PrimNode};

/// The prims authored under /World, sorted by name. Round 2's fixtures all
/// read this file, so the count lives here and nowhere else: adding or
/// renaming a prim must break this one assertion.
const WORLD_PRIMS: [(&str, &str); 11] = [
    ("Cam_tele", "Camera"),
    ("Cam_wide", "Camera"),
    ("Ground", "Mesh"),
    ("L_cyl", "CylinderLight"),
    ("L_disk", "DiskLight"),
    ("L_distant", "DistantLight"),
    ("L_dome", "DomeLight"),
    ("L_dome_tex", "DomeLight"),
    ("L_off", "SphereLight"),
    ("L_rect", "RectLight"),
    ("L_sphere", "SphereLight"),
];

fn open_fixture(state: &common::TestOwner) -> usdbee_lib::stage::StageInfo {
    state.open(&fixture("lights_cameras.usda"))
}

fn world_children(state: &common::TestOwner) -> Vec<PrimNode> {
    let tree = request_stage_tree(&state.sender()).expect("tree should serialize");
    let mut world = tree
        .into_iter()
        .find(|node| node.path == "/World")
        .expect("/World should be in the tree");
    world.children.sort_by(|a, b| a.name.cmp(&b.name));
    world.children
}

fn translation(details: &usdbee_lib::values::PrimDetails) -> [f64; 3] {
    let transform = details
        .local_transform
        .expect("prim should author a local transform");
    // Row-vector convention: the translation sits in the last row.
    [transform[12], transform[13], transform[14]]
}

#[test]
fn fixture_opens_with_the_pinned_world_prims() {
    let state = spawn_stage_owner();
    let info = open_fixture(&state);
    assert!(
        info.composition_errors.is_empty(),
        "composition errors: {:?}",
        info.composition_errors
    );
    assert_eq!(info.up_axis, "Y");

    let children = world_children(&state);
    let found: Vec<(&str, &str)> = children
        .iter()
        .map(|node| (node.name.as_str(), node.type_name.as_str()))
        .collect();
    assert_eq!(found, WORLD_PRIMS.to_vec(), "world prim set changed");
}

#[test]
fn cameras_carry_the_values_a_look_through_needs() {
    let state = spawn_stage_owner();
    open_fixture(&state);
    let sender = state.sender();

    let wide = request_stage_details(&sender, "/World/Cam_wide", None).expect("Cam_wide details");
    assert_eq!(wide.type_name, "Camera");
    assert_eq!(
        attribute(&wide, "focalLength").value.data,
        json!(24.0f32 as f64)
    );
    assert_eq!(
        attribute(&wide, "clippingRange").value.data,
        json!([0.1f32 as f64, 1000.0f32 as f64])
    );
    assert_eq!(translation(&wide), [0.0, 4.0, 8.0]);

    let tele = request_stage_details(&sender, "/World/Cam_tele", None).expect("Cam_tele details");
    assert_eq!(tele.type_name, "Camera");
    assert_eq!(
        attribute(&tele, "focalLength").value.data,
        json!(200.0f32 as f64)
    );
    assert_eq!(translation(&tele), [0.0, 4.0, 20.0]);
}

#[test]
fn sphere_light_authors_its_shaping_and_shadow_inputs() {
    let state = spawn_stage_owner();
    open_fixture(&state);

    let sphere =
        request_stage_details(&state.sender(), "/World/L_sphere", None).expect("L_sphere details");
    assert_eq!(sphere.type_name, "SphereLight");
    // Both need the apiSchemas the fixture prepends; without them the inputs
    // would not compose onto the prim at all.
    assert_eq!(
        attribute(&sphere, "inputs:shaping:cone:angle").value.data,
        json!(30.0f32 as f64)
    );
    assert_eq!(
        attribute(&sphere, "inputs:shaping:cone:softness")
            .value
            .data,
        json!(0.1f32 as f64)
    );
    assert_eq!(
        attribute(&sphere, "inputs:shadow:enable").value.data,
        json!(true)
    );
}

#[test]
fn ground_is_one_flat_quad_with_nothing_to_subdivide() {
    let state = spawn_stage_owner();
    open_fixture(&state);

    let ground =
        request_stage_details(&state.sender(), "/World/Ground", None).expect("Ground details");
    assert_eq!(ground.type_name, "Mesh");
    assert_eq!(
        attribute(&ground, "faceVertexCounts").value.data,
        json!([4])
    );
    assert_eq!(
        attribute(&ground, "subdivisionScheme").value.data,
        json!("none"),
        "a catmullClark quad would round the lights' shadow catcher"
    );
}
