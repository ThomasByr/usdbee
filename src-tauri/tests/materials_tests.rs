use std::path::{Path, PathBuf};

use usdbee_lib::materials::MaterialInfo;
use usdbee_lib::stage::{request_material_data, spawn_stage_owner, StageRequest, StageState};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn open_via_owner(state: &StageState, name: &str) {
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    state
        .sender
        .send(StageRequest::Open {
            path: fixture(name),
            reply: reply_tx,
        })
        .expect("stage owner should accept an open request");
    reply_rx
        .recv()
        .expect("stage owner should reply")
        .expect("stage should open");
}

#[test]
fn mesh_entry_resolves_the_bound_preview_surface() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let info =
        request_material_data(&state.sender, "/World/PlasticBall").expect("material data");
    assert_eq!(info.name, "Plastic");
    let surface = info.surface.expect("Plastic is a UsdPreviewSurface");
    assert_eq!(surface.roughness, Some(0.35f32 as f64));
    assert_eq!(surface.metallic, Some(0.9f32 as f64));
    assert_eq!(surface.opacity, None);
    assert_eq!(surface.normal, None);
    assert!(surface.textures.is_empty(), "Plastic has no textures");
    let color = surface.diffuse_color.expect("authored diffuseColor");
    assert_eq!(color.r#type, "color3f");
    assert_eq!(
        color.data,
        serde_json::json!([0.8f32 as f64, 0.2f32 as f64, 0.2f32 as f64])
    );
}

#[test]
fn material_entry_serializes_the_material_directly() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let info = request_material_data(&state.sender, "/World/Looks/Plastic")
        .expect("material prim serializes");
    assert_eq!(info.name, "Plastic");
    let surface = info.surface.expect("direct material entry");
    assert_eq!(surface.roughness, Some(0.35f32 as f64));
    let color = surface.diffuse_color.expect("authored diffuseColor");
    assert_eq!(color.r#type, "color3f");
}

#[test]
fn textured_surface_resolves_file_paths_and_primvar() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let info = request_material_data(&state.sender, "/World/TexturedBall")
        .expect("textured material data");
    assert_eq!(info.name, "Textured");
    let surface = info.surface.expect("Textured is a UsdPreviewSurface");
    assert_eq!(
        surface.diffuse_color, None,
        "diffuseColor is textured, not a constant"
    );
    assert_eq!(surface.opacity, Some(0.5));
    assert_eq!(surface.roughness, None, "unauthored channels stay None");
    assert_eq!(surface.textures.len(), 2, "diffuseColor + normal textures");

    let checker = std::fs::canonicalize(fixture("checker.png")).expect("fixture texture");
    let albedo = surface
        .textures
        .iter()
        .find(|t| t.input == "diffuseColor")
        .expect("diffuseColor texture input");
    assert_eq!(
        Path::new(&albedo.file_path),
        checker,
        "file_path resolves to the fixture texture"
    );
    assert_eq!(albedo.st_primvar, "uv", "st comes from the primvar reader");

    let normal_input = surface
        .textures
        .iter()
        .find(|t| t.input == "normal")
        .expect("normal texture input");
    assert_eq!(normal_input.st_primvar, "uv");
    let normal = surface.normal.expect("normal TextureInfo");
    assert_eq!(normal.file_path, albedo.file_path);
    assert_eq!(normal.st_primvar, "uv");
}

#[test]
fn missing_texture_file_path_is_returned_not_an_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let info = request_material_data(&state.sender, "/World/Looks/Missing")
        .expect("a missing texture file is never an Err");
    let surface = info.surface.expect("Missing is a UsdPreviewSurface");
    assert_eq!(surface.textures.len(), 1);
    let texture = &surface.textures[0];
    assert!(
        texture.file_path.ends_with("does_not_exist.png"),
        "unresolved spelling returned anyway: {}",
        texture.file_path
    );
    assert!(
        !Path::new(&texture.file_path).exists(),
        "the fixture deliberately references a missing file"
    );
    assert_eq!(texture.st_primvar, "st", "no st connection defaults to st");
}

#[test]
fn unbound_mesh_answers_prim_name_with_no_surface() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let info = request_material_data(&state.sender, "/World/Unbound")
        .expect("unbound is not an error");
    assert_eq!(
        info,
        MaterialInfo {
            name: "Unbound".to_string(),
            surface: None,
        }
    );
}

#[test]
fn unknown_shader_id_fails_soft_to_no_surface() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let info =
        request_material_data(&state.sender, "/World/FancyBall").expect("bound mesh resolves");
    assert_eq!(info.name, "CustomShader");
    assert_eq!(info.surface, None, "non-UsdPreviewSurface ids are skipped");
}

#[test]
fn missing_prim_is_a_readable_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let error = request_material_data(&state.sender, "/World/Nope").unwrap_err();
    assert!(error.contains("prim not found"), "got: {}", error);
}

#[test]
fn material_request_without_open_stage_fails() {
    let state = spawn_stage_owner();
    assert_eq!(
        request_material_data(&state.sender, "/World").unwrap_err(),
        "no stage open"
    );
}
