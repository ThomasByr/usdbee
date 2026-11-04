use std::path::{Path, PathBuf};

mod common;

use common::spawn_stage_owner;
use usdbee_lib::materials::{material_info, MaterialInfo, UvTransform};
use usdbee_lib::stage::{open_stage, request_material_data};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn open_via_owner(state: &common::TestOwner, name: &str) {
    state.open(&fixture(name));
}

#[test]
fn mesh_entry_resolves_the_bound_preview_surface() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let info = request_material_data(&state.sender(), "/World/PlasticBall").expect("material data");
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

    let info = request_material_data(&state.sender(), "/World/Looks/Plastic")
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

    let info = request_material_data(&state.sender(), "/World/TexturedBall")
        .expect("textured material data");
    assert_eq!(info.name, "Textured");
    let surface = info.surface.expect("Textured is a UsdPreviewSurface");
    assert_eq!(
        surface.diffuse_color, None,
        "diffuseColor is textured, not a constant"
    );
    assert_eq!(
        surface.opacity, None,
        "textured opacity has no scalar value"
    );
    assert_eq!(
        surface.roughness, None,
        "textured roughness has no scalar value"
    );
    assert_eq!(
        surface.metallic, None,
        "textured metallic has no scalar value"
    );
    assert_eq!(
        surface.textures.len(),
        5,
        "diffuseColor + normal + roughness + metallic + opacity textures"
    );
    for channel in ["roughness", "metallic", "opacity"] {
        assert!(
            surface
                .textures
                .iter()
                .any(|texture| texture.input == channel),
            "{channel} texture input must reach the frontend"
        );
    }

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

    let info = request_material_data(&state.sender(), "/World/Looks/Missing")
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

    let info =
        request_material_data(&state.sender(), "/World/Unbound").expect("unbound is not an error");
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
        request_material_data(&state.sender(), "/World/FancyBall").expect("bound mesh resolves");
    assert_eq!(info.name, "CustomShader");
    assert_eq!(info.surface, None, "non-UsdPreviewSurface ids are skipped");
}

#[test]
fn missing_prim_is_a_readable_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let error = request_material_data(&state.sender(), "/World/Nope").unwrap_err();
    assert!(error.contains("prim not found"), "got: {}", error);
}

#[test]
fn usdz_texture_resolves_inside_extracted_directory() {
    use std::io::{Read, Write};

    let source_dir = tempfile::tempdir().expect("source temp dir");
    let source = source_dir.path().join("root.usda");
    std::fs::write(
        &source,
        r#"#usda 1.0

def Mesh "Mesh" {
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    rel material:binding = </Material>
}
def Material "Material" {
    token outputs:surface.connect = </Material/Preview.outputs:surface>
    def Shader "Texture" {
        uniform token info:id = "UsdUVTexture"
        asset inputs:file = @./textures/checker.png@
        float3 outputs:rgb
    }
    def Shader "Preview" {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor.connect = </Material/Texture.outputs:rgb>
        token outputs:surface
    }
}
"#,
    )
    .expect("source stage should be written");
    let layer = openusd::sdf::Layer::open(source.to_str().expect("UTF-8 source path"))
        .expect("source layer should open");
    let usdc = source_dir.path().join("root.usdc");
    layer
        .export(usdc.to_str().expect("UTF-8 usdc path"))
        .expect("usdc export should succeed");

    let archive_path = source_dir.path().join("textured.usdz");
    let mut writer =
        zip::ZipWriter::new(std::fs::File::create(&archive_path).expect("usdz create"));
    writer
        .start_file("root.usdc", zip::write::SimpleFileOptions::default())
        .expect("root entry");
    writer
        .write_all(&std::fs::read(&usdc).expect("usdc bytes"))
        .expect("root entry bytes");
    writer
        .start_file(
            "textures/checker.png",
            zip::write::SimpleFileOptions::default(),
        )
        .expect("texture entry");
    writer
        .write_all(&std::fs::read(fixture("checker.png")).expect("texture bytes"))
        .expect("texture entry bytes");
    writer.finish().expect("usdz finish");

    let extracted = usdbee_lib::get_usdbee_cache_dir()
        .join("extracted")
        .join(format!("usdz_texture_pin_{}", std::process::id()));
    std::fs::create_dir_all(&extracted).expect("extracted root");
    let mut archive = zip::ZipArchive::new(
        std::fs::File::open(&archive_path).expect("generated usdz should open"),
    )
    .expect("generated usdz should parse");
    for name in ["root.usdc", "textures/checker.png"] {
        let mut entry = archive.by_name(name).expect("archive entry");
        let destination = extracted.join(name);
        std::fs::create_dir_all(destination.parent().expect("entry parent"))
            .expect("entry parent should be created");
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).expect("entry should read");
        std::fs::write(destination, bytes).expect("entry should extract");
    }

    let (stage, info) =
        open_stage(&extracted.join("root.usdc")).expect("extracted usdz root should open");
    assert!(info.composition_errors.is_empty());
    let material = material_info(&stage, "/Mesh").expect("material should resolve");
    let texture = &material.surface.expect("preview surface").textures[0];
    let texture_path = Path::new(&texture.file_path);
    assert!(texture_path.starts_with(&extracted));
    assert!(
        texture_path.is_file(),
        "{} must exist",
        texture_path.display()
    );

    std::fs::remove_dir_all(&extracted).expect("extracted pin cleanup");
}

#[test]
fn material_request_without_open_stage_fails() {
    // No stage open means id 0 — the id lookup is the readable guard every
    // command shape (including get_material_data) routes through.
    let state = spawn_stage_owner();
    assert_eq!(state.state.sender(0).unwrap_err(), "no stage 0");
}

#[test]
fn transform2d_chain_wrap_tokens_and_value_scale_reach_the_payload() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_tiling.usda");

    let info = request_material_data(&state.sender(), "/World/TiledBall").expect("tiled material data");
    assert_eq!(info.name, "Tiled");
    let surface = info.surface.expect("Tiled is a UsdPreviewSurface");

    let albedo = surface
        .textures
        .iter()
        .find(|t| t.input == "diffuseColor")
        .expect("diffuseColor texture input");
    assert_eq!(albedo.st_primvar, "uv", "the reader sits behind the Transform2d");
    assert_eq!(albedo.wrap_s.as_deref(), Some("mirror"));
    assert_eq!(albedo.wrap_t.as_deref(), Some("clamp"));
    assert_eq!(albedo.color_space.as_deref(), Some("raw"));
    assert_eq!(albedo.value_scale, Some([2.0, 2.0, 2.0, 1.0]));
    assert_eq!(albedo.value_bias, Some([-1.0, -1.0, -1.0, 0.0]));
    assert_eq!(
        albedo.uv_transform,
        Some(UvTransform {
            scale: [6.0, 10.0],
            translation: [0.25, -0.5],
            rotation: 90.0,
        })
    );

    let normal = surface
        .textures
        .iter()
        .find(|t| t.input == "normal")
        .expect("normal texture input");
    assert_eq!(normal.wrap_s.as_deref(), Some("repeat"));
    assert_eq!(normal.wrap_t.as_deref(), Some("repeat"));
    assert_eq!(normal.uv_transform, None, "st connects straight to the reader");
    assert_eq!(normal.value_scale, None);
    assert_eq!(normal.value_bias, None);
    let normal_info = surface.normal.expect("normal TextureInfo");
    assert_eq!(normal_info.wrap_s.as_deref(), Some("repeat"));
    assert_eq!(normal_info.uv_transform, None);
}

#[test]
fn unauthored_wrap_transform_and_scale_default_to_identity() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_tiling.usda");

    let info = request_material_data(&state.sender(), "/World/PlainBall").expect("plain material data");
    let surface = info.surface.expect("Plain is a UsdPreviewSurface");
    assert_eq!(surface.textures.len(), 1);
    let texture = &surface.textures[0];
    assert_eq!(texture.wrap_s, None, "unauthored wrapS stays None");
    assert_eq!(texture.wrap_t, None);
    assert_eq!(texture.color_space, None, "unauthored sourceColorSpace stays None");
    assert_eq!(texture.uv_transform, None, "no st connection means no transform");
    assert_eq!(texture.value_scale, None);
    assert_eq!(texture.value_bias, None);
    assert_eq!(texture.st_primvar, "st", "no st connection defaults to st");
}
