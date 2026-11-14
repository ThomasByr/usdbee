mod common;

use common::{attribute, fixture, spawn_stage_owner};
use serde_json::json;
use std::fs;
use usdbee_lib::lights::{stage_lights, LightInfo};
use usdbee_lib::stage::{
    open_stage, request_stage_details, request_stage_lights, request_stage_tree, PrimNode,
};

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

    // Pin the applied schemas, not only the values. A prim keeps any authored
    // attribute whether or not a schema applies it, so the value assertions
    // below do not prove the fixture's `prepend apiSchemas` took effect;
    // later tasks read these inputs through the typed schema views, which
    // exist only when the schema is applied. No light class applies these two
    // by default, so these assertions go red when the `prepend` is dropped.
    let (stage, _) = open_stage(&fixture("lights_cameras.usda")).expect("stage should open");
    let sphere_prim = stage
        .prim("/World/L_sphere")
        .expect("L_sphere should exist");
    assert!(
        sphere_prim
            .has_api_schema("ShapingAPI")
            .expect("apiSchemas should resolve"),
        "L_sphere must apply ShapingAPI for its shaping inputs to compose"
    );
    assert!(
        sphere_prim
            .has_api_schema("ShadowAPI")
            .expect("apiSchemas should resolve"),
        "L_sphere must apply ShadowAPI for its shadow inputs to compose"
    );

    let sphere =
        request_stage_details(&state.sender(), "/World/L_sphere", None).expect("L_sphere details");
    assert_eq!(sphere.type_name, "SphereLight");
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

fn closed(expected: f64, actual: f64) {
    assert!(
        (expected - actual).abs() < 1e-6,
        "expected {}, got {}",
        expected,
        actual
    );
}

/// One light authored under an ancestor whose visibility the test controls.
/// The scene is written per test: the shared fixture must stay untouched, and
/// inherited visibility is the only way a light goes off without its own
/// `token visibility`.
fn ancestor_visibility_lights(ancestor_visibility: &str) -> Vec<LightInfo> {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let root = dir.path().join("inherited_visibility.usda");
    fs::write(
        &root,
        format!(
            r#"#usda 1.0

def Xform "World"
{{
    def Xform "Hidden" (
        kind = "group"
    )
    {{
        token visibility = "{ancestor_visibility}"

        def SphereLight "L_child"
        {{
            float inputs:intensity = 7
        }}
    }}

    def SphereLight "L_sibling"
    {{
        float inputs:intensity = 8
    }}
}}
"#
        ),
    )
    .expect("test stage should be written");

    let (stage, _) = open_stage(&root).expect("stage should open");
    let mut lights = stage_lights(&stage, None);
    lights.sort_by(|a, b| a.path.cmp(&b.path));
    lights
}

#[test]
fn an_invisible_ancestor_disables_the_light_underneath() {
    let hidden = ancestor_visibility_lights("invisible");
    let paths: Vec<&str> = hidden.iter().map(|l| l.path.as_str()).collect();
    assert_eq!(
        paths,
        ["/World/Hidden/L_child", "/World/L_sibling"],
        "a light under an invisible Xform still answers"
    );
    assert!(
        !light(&hidden, "/World/Hidden/L_child").enabled,
        "the light inherits the ancestor's invisible visibility: enabled is the computed \
         visibility, not the prim's own opinion"
    );
    assert!(
        light(&hidden, "/World/L_sibling").enabled,
        "a sibling outside the invisible group stays on"
    );

    let shown = ancestor_visibility_lights("inherited");
    assert!(
        light(&shown, "/World/Hidden/L_child").enabled,
        "an inherited ancestor visibility leaves the light on"
    );
}

#[test]
fn a_legacy_dome_light_answers_as_a_dome() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let root = dir.path().join("legacy_dome.usda");
    fs::write(
        &root,
        r#"#usda 1.0

def Xform "World"
{
    # The pre-0.8 dome light: its own class, not a subtype of `DomeLight`.
    # A legacy asset must not lose its dome light.
    def DomeLight_1 "L_legacy"
    {
        float inputs:intensity = 3
        color3f inputs:color = (0.25, 0.5, 0.75)
        asset inputs:texture:file = @./sky.exr@
    }
}
"#,
    )
    .expect("test stage should be written");

    let (stage, _) = open_stage(&root).expect("stage should open");
    let lights = stage_lights(&stage, None);
    let legacy = light(&lights, "/World/L_legacy");
    assert_eq!(legacy.kind, "dome");
    assert_eq!(legacy.intensity, 3.0);
    closed(0.25, legacy.color[0]);
    closed(0.5, legacy.color[1]);
    closed(0.75, legacy.color[2]);
    assert!(
        legacy
            .texture_file
            .as_deref()
            .is_some_and(|path| path.ends_with("sky.exr")),
        "the legacy dome's texture path reaches the payload: {:?}",
        legacy.texture_file
    );
    assert!(legacy.enabled);
}

fn fixture_lights() -> Vec<LightInfo> {
    let (stage, _) = open_stage(&fixture("lights_cameras.usda")).expect("stage should open");
    let mut lights = stage_lights(&stage, None);
    lights.sort_by(|a, b| a.path.cmp(&b.path));
    lights
}

fn light<'a>(lights: &'a [LightInfo], path: &str) -> &'a LightInfo {
    lights
        .iter()
        .find(|l| l.path == path)
        .unwrap_or_else(|| panic!("expected {} among {:?}", path, lights))
}

#[test]
fn fixture_lights_carry_the_values_the_mapping_needs() {
    let lights = fixture_lights();
    let paths: Vec<&str> = lights.iter().map(|l| l.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/World/L_cyl",
            "/World/L_disk",
            "/World/L_distant",
            "/World/L_dome",
            "/World/L_dome_tex",
            "/World/L_off",
            "/World/L_rect",
            "/World/L_sphere",
        ],
        "every light prim answers, and nothing else does"
    );

    let sphere = light(&lights, "/World/L_sphere");
    assert_eq!(sphere.kind, "sphere");
    assert_eq!(sphere.intensity, 800.0);
    assert_eq!(sphere.exposure, 0.0);
    closed(1.0, sphere.color[0]);
    closed(0.9, sphere.color[1]);
    closed(0.8, sphere.color[2]);
    assert_eq!(sphere.radius, Some(0.5));
    let shaping = sphere
        .shaping
        .as_ref()
        .expect("L_sphere applies ShapingAPI");
    closed(30.0, shaping.cone_angle);
    closed(0.1, shaping.cone_softness);
    assert!(sphere.casts_shadow, "L_sphere applies ShadowAPI");
    assert!(sphere.enabled);
    assert!(!sphere.normalize);
    assert_eq!(sphere.angle, None);
    assert_eq!(sphere.width, None);
    assert_eq!(sphere.texture_file, None);

    let disk = light(&lights, "/World/L_disk");
    assert_eq!(disk.kind, "disk");
    assert_eq!(disk.intensity, 100.0);
    assert_eq!(disk.radius, Some(1.0));
    assert_eq!(
        disk.color,
        [1.0, 1.0, 1.0],
        "an unauthored color takes the schema fallback"
    );
    assert_eq!(disk.shaping, None, "no ShapingAPI here");
    assert!(
        disk.casts_shadow,
        "a light that applies no ShadowAPI is not shadow-disabled: the schema's own \
         shadow:enable fallback (true) answers for it"
    );

    let rect = light(&lights, "/World/L_rect");
    assert_eq!(rect.kind, "rect");
    assert_eq!(rect.intensity, 50.0);
    assert_eq!(rect.width, Some(2.0));
    assert_eq!(rect.height, Some(1.0));
    assert_eq!(rect.texture_file, None, "no texture authored");

    let cylinder = light(&lights, "/World/L_cyl");
    assert_eq!(cylinder.kind, "cylinder");
    assert_eq!(cylinder.intensity, 40.0);
    assert_eq!(cylinder.length, Some(3.0));
    closed(0.2, cylinder.radius.expect("the cylinder authors a radius"));

    let distant = light(&lights, "/World/L_distant");
    assert_eq!(distant.kind, "distant");
    assert_eq!(distant.intensity, 2.0);
    assert_eq!(distant.angle, Some(45.0));
    assert_eq!(distant.radius, None);

    let dome = light(&lights, "/World/L_dome");
    assert_eq!(dome.kind, "dome");
    assert_eq!(dome.intensity, 1.0);
    closed(0.5, dome.color[0]);
    closed(0.6, dome.color[1]);
    closed(1.0, dome.color[2]);
    assert_eq!(dome.texture_file, None);

    let textured = light(&lights, "/World/L_dome_tex");
    assert_eq!(textured.kind, "dome");
    assert!(
        textured
            .texture_file
            .as_deref()
            .is_some_and(|path| path.ends_with("checker.png")),
        "the dome's texture path reaches the payload: {:?}",
        textured.texture_file
    );
    assert!(
        textured.casts_shadow,
        "no ShadowAPI composes no shadow:enable, so the schema fallback answers"
    );

    let off = light(&lights, "/World/L_off");
    assert_eq!(off.kind, "sphere");
    assert_eq!(off.intensity, 5.0);
    assert!(
        !off.enabled,
        "visibility = invisible is the switch USD has: the light answers disabled"
    );
}

/// The translation of a light's world transform (row-vector: last row).
fn light_translation(info: &LightInfo) -> [f64; 3] {
    let transform = info
        .world_transform
        .expect("the light should carry a world transform");
    [transform[12], transform[13], transform[14]]
}

/// The forward axis (-Z) of a light's world transform, normalized.
fn forward(info: &LightInfo) -> [f64; 3] {
    let transform = info
        .world_transform
        .expect("the light should carry a world transform");
    let axis = [-transform[8], -transform[9], -transform[10]];
    let length = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    [axis[0] / length, axis[1] / length, axis[2] / length]
}

#[test]
fn fixture_lights_carry_the_transforms_the_placement_needs() {
    let lights = fixture_lights();

    assert_eq!(
        light_translation(light(&lights, "/World/L_sphere")),
        [0.0, 3.0, 0.0]
    );
    assert_eq!(
        light_translation(light(&lights, "/World/L_rect")),
        [-3.0, 2.0, 0.0]
    );
    assert_eq!(
        light_translation(light(&lights, "/World/L_cyl")),
        [0.0, 1.0, 3.0]
    );

    // L_distant authors rotateXYZ = (-45, 0, 0): its forward axis tilts out of
    // the XZ plane instead of staying straight down.
    let distant = light(&lights, "/World/L_distant");
    let [x, y, z] = forward(distant);
    closed(0.0, x);
    assert!(
        z < 0.0 && y < 0.0,
        "-45 about X aims -Z down and back: {:?}",
        [x, y, z]
    );
    closed(-std::f64::consts::FRAC_1_SQRT_2, z);
    closed(-std::f64::consts::FRAC_1_SQRT_2, y);

    // A light with no xformOpOrder sits at the origin, not without a place.
    assert_eq!(
        light_translation(light(&lights, "/World/L_dome")),
        [0.0, 0.0, 0.0]
    );
}

#[test]
fn an_unevaluable_xform_still_answers_the_light() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let root = dir.path().join("bad_xform_light.usda");
    fs::write(
        &root,
        r#"#usda 1.0

def Xform "World"
{
    # The op name is right but its value is undecodable: the light answers
    # without a transform instead of dropping out.
    def SphereLight "L_bad_xform"
    {
        string xformOp:orient = "bogus"
        uniform token[] xformOpOrder = ["xformOp:orient"]
    }
}
"#,
    )
    .expect("test stage should be written");

    let (stage, _) = open_stage(&root).expect("stage should open");
    let lights = stage_lights(&stage, None);
    let broken = light(&lights, "/World/L_bad_xform");
    assert_eq!(broken.kind, "sphere");
    assert!(
        broken.world_transform.is_none(),
        "no transform beats a wrong one: {:?}",
        broken.world_transform
    );
}

#[test]
fn an_unreadable_light_drops_itself_and_the_rest_still_answer() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let root = dir.path().join("broken_light.usda");
    fs::write(
        &root,
        r#"#usda 1.0

def Xform "World"
{
    def SphereLight "L_ok"
    {
        float inputs:intensity = 3
    }

    # Composition cannot resolve this light's reference: the stage still
    # opens, and the light answers on its own opinions.
    def SphereLight "L_dangling" (
        references = @./does_not_exist.usda@
    )
    {
        float inputs:intensity = 4
    }

    # Nonsense typed attrs are dropped by composition, never an error: the
    # reads fold the schema fallback instead of failing the light.
    def SphereLight "L_nonsense"
    {
        string inputs:intensity = "x"
        string inputs:radius = "wide"
        token visibility = "bogus"
    }

    # The traversal's own rules drop these two: abstract and inactive prims
    # are no part of the composed stage.
    class SphereLight "L_abstract"
    {
    }

    def SphereLight "L_inactive" (
        active = false
    )
    {
    }

    # Recorded limits: these kinds are skipped, not guessed at.
    def PortalLight "Portal"
    {
        float inputs:intensity = 9
    }

    def GeometryLight "Geo"
    {
    }

    def LightFilter "Filter"
    {
    }
}
"#,
    )
    .expect("test stage should be written");

    let (stage, _) = open_stage(&root).expect("stage should open");
    let mut lights = stage_lights(&stage, None);
    lights.sort_by(|a, b| a.path.cmp(&b.path));
    let paths: Vec<&str> = lights.iter().map(|l| l.path.as_str()).collect();
    assert_eq!(
        paths,
        ["/World/L_dangling", "/World/L_nonsense", "/World/L_ok"],
        "the unreadable prims leave the rest of the list intact"
    );
    assert_eq!(light(&lights, "/World/L_ok").intensity, 3.0);
    assert_eq!(
        light(&lights, "/World/L_dangling").intensity,
        4.0,
        "a dangling reference still answers its own opinion"
    );
    let nonsense = light(&lights, "/World/L_nonsense");
    assert_eq!(nonsense.intensity, 1.0, "folded fallback, not a drop");
    assert_eq!(nonsense.radius, Some(0.5), "folded fallback, not a drop");
    assert!(nonsense.enabled, "an undecodable token is not invisible");
}

#[test]
fn the_lights_command_answers_through_the_stage_owner() {
    let state = spawn_stage_owner();
    open_fixture(&state);
    let lights = request_stage_lights(&state.sender()).expect("lights should serialize");
    assert_eq!(
        lights.len(),
        8,
        "all eight fixture lights reach the command"
    );
}
