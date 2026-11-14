use std::path::{Path, PathBuf};

mod common;

use common::spawn_stage_owner;
use usdbee_lib::materials::{
    material_info, MaterialInfo, PreviewSurface, TextureInput, UvTransform,
};
use usdbee_lib::stage::{open_stage, request_material_batch, request_material_data};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn open_via_owner(state: &common::TestOwner, name: &str) -> usdbee_lib::stage::StageInfo {
    state.open(&fixture(name))
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
    assert_eq!(
        surface.opacity,
        Some(1.0f32 as f64),
        "an unauthored opacity folds the node definition's 1.0"
    );
    assert_eq!(
        surface.normal, None,
        "normal carries only a texture; a constant normal is not modeled"
    );
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
            displacement: None,
            has_volume: false,
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
fn materials_full_fixture_opens() {
    // Guard for the material-support fixture: it opens through the owner
    // thread, composes clean, and every prim the material tasks address
    // serializes without panicking. Binding semantics are asserted by the
    // tests for the tasks that implement them.
    let state = spawn_stage_owner();
    let info = open_via_owner(&state, "materials_full.usda");
    assert!(
        info.composition_errors.is_empty(),
        "composition errors: {:?}",
        info.composition_errors
    );
    assert_eq!(info.up_axis, "Y");

    let red = request_material_data(&state.sender(), "/Materials/Red").expect("Red serializes");
    assert_eq!(red.name, "Red");
    let surface = red.surface.expect("Red is a UsdPreviewSurface");
    let diffuse = surface.diffuse_color.expect("authored diffuseColor");
    assert_eq!(
        diffuse.data,
        serde_json::json!([0.8f32 as f64, 0.1f32 as f64, 0.1f32 as f64])
    );

    for path in [
        "/Materials/Green",
        "/Materials/Blue",
        "/Materials/RoughTex",
        "/Materials/Yellow",
        "/Materials/Wide",
        "/Materials/Disp",
        "/Materials/Vol",
        "/Materials/Mul",
        "/Materials/Tiled",
        "/Materials/Cyan",
        "/Root/Tri_collection",
        "/Root/Tri_preview",
        "/Root/Tri_graph_const",
        "/Root/Tri_graph_tex",
        "/Root/Tri_context",
        "/Root/Tri_wide",
        "/Root/Tri_disp",
        "/Root/Tri_vol",
        "/Root/Tri_mul",
        "/Root/Tri_tiled",
        "/Root/Tri_full",
        "/Root/Tri_nonmat",
        "/Root/Anc/Tri_ancdirect",
    ] {
        request_material_data(&state.sender(), path)
            .unwrap_or_else(|e| panic!("{} serializes: {}", path, e));
    }
}

// Binding resolution (spec R1/R2) over materials_full.usda: the fixture
// gives each prim one binding shape, so each test pins a single rule.
fn bound_diffuse(state: &common::TestOwner, path: &str) -> serde_json::Value {
    let info = request_material_data(&state.sender(), path)
        .unwrap_or_else(|e| panic!("{} resolves: {}", path, e));
    let surface = info
        .surface
        .unwrap_or_else(|| panic!("{} resolves a UsdPreviewSurface", path));
    surface
        .diffuse_color
        .unwrap_or_else(|| panic!("{} has an authored diffuseColor", path))
        .data
}

fn color(r: f32, g: f32, b: f32) -> serde_json::Value {
    serde_json::json!([r as f64, g as f64, b as f64])
}

#[test]
fn collection_bound_mesh_resolves_material() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    assert_eq!(
        bound_diffuse(&state, "/Root/Tri_collection"),
        color(0.8, 0.1, 0.1),
        "a collection binding naming the mesh resolves the collection's material"
    );
}

#[test]
fn purpose_binding_beats_all_purpose() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    assert_eq!(
        bound_diffuse(&state, "/Root/Tri_preview"),
        color(0.1, 0.8, 0.1),
        "the preview-purpose binding outranks the all-purpose one on the same prim"
    );
}

#[test]
fn all_purpose_binding_resolves_without_purpose_rel() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    // The diffuse constant flows through Blue's NodeGraph interface, which
    // this task does not resolve; the binding identity is the guard here.
    let info = request_material_data(&state.sender(), "/Root/Tri_graph_const")
        .expect("an all-purpose binding resolves");
    assert_eq!(
        info.name, "Blue",
        "a plain all-purpose binding still resolves when no purpose rel is authored"
    );
}

#[test]
fn render_context_only_terminal_resolves() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    assert_eq!(
        bound_diffuse(&state, "/Root/Tri_context"),
        color(0.9, 0.9, 0.1),
        "a material with only a render-context surface terminal still serializes"
    );
}

#[test]
fn full_purpose_only_binding_resolves() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    assert_eq!(
        bound_diffuse(&state, "/Root/Tri_full"),
        color(0.1, 0.8, 0.8),
        "a full-only binding is rescued by the second purpose query"
    );
}

#[test]
fn ancestor_collection_binding_outranks_descendant_direct() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    assert_eq!(
        bound_diffuse(&state, "/Root/Anc/Tri_ancdirect"),
        color(0.1, 0.8, 0.1),
        "bindMaterialAs = strongerThanDescendants on the ancestor collection binding wins"
    );
}

#[test]
fn binding_to_non_material_prim_answers_unbound() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    let info = request_material_data(&state.sender(), "/Root/Tri_nonmat")
        .expect("a binding to a non-Material prim is not an error");
    assert_eq!(
        info,
        MaterialInfo {
            name: "Tri_nonmat".to_string(),
            surface: None,
            displacement: None,
            has_volume: false,
        }
    );
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

    let info =
        request_material_data(&state.sender(), "/World/TiledBall").expect("tiled material data");
    assert_eq!(info.name, "Tiled");
    let surface = info.surface.expect("Tiled is a UsdPreviewSurface");

    let albedo = surface
        .textures
        .iter()
        .find(|t| t.input == "diffuseColor")
        .expect("diffuseColor texture input");
    assert_eq!(
        albedo.st_primvar, "uv",
        "the reader sits behind the Transform2d"
    );
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
    assert_eq!(
        normal.uv_transform, None,
        "st connects straight to the reader"
    );
    assert_eq!(normal.value_scale, None);
    assert_eq!(normal.value_bias, None);
    let normal_info = surface.normal.expect("normal TextureInfo");
    assert_eq!(normal_info.wrap_s.as_deref(), Some("repeat"));
    assert_eq!(normal_info.uv_transform, None);
}

// Producer-walk channel resolution (spec R3/R4) over materials_full.usda and
// material_cycle.usda: every PreviewSurface input resolves through its
// producers, and an unwired, unauthored channel folds the node definition's
// default.
fn surface_of(state: &common::TestOwner, path: &str) -> PreviewSurface {
    request_material_data(&state.sender(), path)
        .unwrap_or_else(|e| panic!("{} resolves: {}", path, e))
        .surface
        .unwrap_or_else(|| panic!("{} resolves a UsdPreviewSurface", path))
}

#[test]
fn nodegraph_interface_constant_feeds_diffuse() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    assert_eq!(
        bound_diffuse(&state, "/Root/Tri_graph_const"),
        color(0.1, 0.1, 0.8),
        "the diffuseColor constant is reached through the NodeGraph interface"
    );
    let surface = surface_of(&state, "/Root/Tri_graph_const");
    assert_eq!(
        surface
            .diffuse_color
            .expect("the interface value serializes")
            .r#type,
        "color3f",
        "the input's declared type names the payload"
    );
    assert!(
        surface.textures.is_empty(),
        "an interface constant is no texture"
    );
}

#[test]
fn nodegraph_wrapped_texture_feeds_roughness() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    let surface = surface_of(&state, "/Root/Tri_graph_tex");
    let roughness = surface
        .textures
        .iter()
        .find(|texture| texture.input == "roughness")
        .expect("the texture inside the NodeGraph feeds roughness");
    let checker = std::fs::canonicalize(fixture("checker.png")).expect("fixture texture");
    assert_eq!(Path::new(&roughness.file_path), checker);
    assert_eq!(
        roughness.st_primvar, "uv",
        "the graph's reader names the primvar, not the fallback"
    );
    assert_eq!(
        surface.roughness, None,
        "a textured channel serializes no constant"
    );
}

#[test]
fn unauthored_channels_fold_definition_defaults() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    let red = surface_of(&state, "/Materials/Red");
    assert_eq!(
        red.roughness,
        Some(0.5f32 as f64),
        "an unwired, unauthored roughness folds the node definition's 0.5"
    );
    assert_eq!(red.metallic, Some(0.0));
    assert_eq!(red.opacity, Some(1.0f32 as f64));
    assert_eq!(
        red.diffuse_color.expect("authored diffuseColor").data,
        color(0.8, 0.1, 0.1),
        "an authored channel keeps its value"
    );

    let wide = surface_of(&state, "/Root/Tri_wide");
    let diffuse = wide
        .diffuse_color
        .expect("the definition default diffuseColor");
    assert_eq!(
        diffuse.data,
        color(0.18, 0.18, 0.18),
        "nothing authored folds the node definition's 0.18 gray"
    );
    assert_eq!(diffuse.r#type, "color3f");
}

#[test]
fn unauthored_specular_color_stays_none() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    let red = surface_of(&state, "/Materials/Red");
    assert_eq!(
        red.specular_color, None,
        "specularColor is authored-only: USD gates its (0,0,0) default to the \
         specular workflow, so an unauthored channel leaves three's ior-derived \
         dielectric F0 in place"
    );
}

#[test]
fn unsupported_producer_drops_channel() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    let surface = surface_of(&state, "/Root/Tri_mul");
    assert_eq!(
        surface.roughness, None,
        "a Multiply output produces no channel this viewport models"
    );
    assert!(
        !surface
            .textures
            .iter()
            .any(|texture| texture.input == "roughness"),
        "an unsupported producer is no texture either"
    );
}

#[test]
fn cyclic_connection_drops_channel_fail_soft() {
    let state = spawn_stage_owner();
    let info = open_via_owner(&state, "material_cycle.usda");
    assert!(
        info.composition_errors.is_empty(),
        "composition errors: {:?}",
        info.composition_errors
    );

    let surface = surface_of(&state, "/Cyclic");
    assert_ne!(
        surface.roughness,
        Some(0.5f32 as f64),
        "an empty walk with a connection is a cycle, not a default"
    );
    assert_eq!(surface.roughness, None, "the cyclic channel drops");
}

// Channel widening and terminal serialization (spec R5/R6) over
// materials_full.usda: the widened PreviewSurface channels, the displacement
// terminal and the volume flag.
#[test]
fn wide_channels_serialize() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    let surface = surface_of(&state, "/Root/Tri_wide");
    assert_eq!(
        surface.emissive_color.expect("authored emissiveColor").data,
        color(1.0, 0.5, 0.1)
    );
    assert_eq!(
        surface.specular_color.expect("authored specularColor").data,
        color(0.2, 0.2, 0.2)
    );
    assert_eq!(surface.clearcoat, Some(0.8f32 as f64));
    assert_eq!(surface.clearcoat_roughness, Some(0.2f32 as f64));
    assert_eq!(surface.ior, Some(1.4f32 as f64));
    assert_eq!(surface.opacity_threshold, Some(0.5f32 as f64));
    assert_eq!(
        surface.occlusion, None,
        "occlusion is textured, so it serializes no constant"
    );

    let checker = std::fs::canonicalize(fixture("checker.png")).expect("fixture texture");
    let occlusion = surface
        .textures
        .iter()
        .find(|texture| texture.input == "occlusion")
        .expect("occlusion texture input must reach the frontend");
    assert_eq!(Path::new(&occlusion.file_path), checker);
    assert_eq!(occlusion.st_primvar, "st");
}

#[test]
fn tri_wide_constant_and_texture_both_absent_double_check() {
    // Texture-wins rule (spec R3), pinned on the widened occlusion channel:
    // a texture-fed channel serializes no constant at all, not even the node
    // definition's 1.0 default, while its constant neighbours keep their own
    // values.
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    let surface = surface_of(&state, "/Root/Tri_wide");
    assert_eq!(surface.occlusion, None, "texture-fed: no constant");
    assert_eq!(
        surface.clearcoat,
        Some(0.8f32 as f64),
        "a constant channel beside it is unaffected"
    );
    assert!(
        surface
            .textures
            .iter()
            .any(|texture| texture.input == "occlusion"),
        "the occlusion texture is listed"
    );
}

#[test]
fn displacement_terminal_serializes() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    let info = request_material_data(&state.sender(), "/Root/Tri_disp")
        .expect("a displacement-only material resolves");
    assert_eq!(info.surface, None, "Disp authors no surface terminal");
    let displacement = info
        .displacement
        .expect("the displacement terminal serializes");
    assert_eq!(displacement.scale, Some(0.05f32 as f64));
    assert_eq!(displacement.file_path, None, "a constant is no texture");
}

#[test]
fn volume_terminal_flags_has_volume() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "materials_full.usda");

    let info = request_material_data(&state.sender(), "/Root/Tri_vol")
        .expect("a volume-only material resolves");
    assert!(info.has_volume, "the volume terminal answers Some");
    assert_eq!(info.surface, None, "Vol authors no surface terminal");
    assert_eq!(info.displacement, None, "Vol authors no displacement");
}

// Batched material fetch (Phase 2 Task 3): one channel round trip for many
// paths, each slot the JSON bytes of MaterialInfo (or the error message for a
// failed path), framed by stage.rs::frame_batch — the geometry batch frame,
// with JSON slots instead of USDB frames.
fn material_batch_slots(bytes: &[u8]) -> Vec<(u32, Vec<u8>)> {
    fn u32_le(bytes: &[u8], index: usize) -> u32 {
        u32::from_le_bytes(bytes[index..index + 4].try_into().unwrap())
    }
    let mut offset: usize = 12;
    let mut slots = Vec::new();
    while offset < bytes.len() {
        let status = u32_le(bytes, offset);
        let len = u32_le(bytes, offset + 4) as usize;
        slots.push((status, bytes[offset + 8..offset + 8 + len].to_vec()));
        offset += 8 + ((len + 3) & !3);
    }
    slots
}

#[test]
fn material_batch_frames_json_slots_and_mirrors_per_path_semantics() {
    // Each ok slot carries the exact MaterialInfo the per-path command
    // returns, including the direct-material and unbound-prim shapes.
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let paths = vec![
        "/World/PlasticBall".to_string(),
        "/World/Looks/Plastic".to_string(),
        "/World/Unbound".to_string(),
    ];
    let bytes = request_material_batch(&state.sender(), &paths).expect("batch should frame");

    let header = |index: usize| u32::from_le_bytes(bytes[index..index + 4].try_into().unwrap());
    assert_eq!(header(0), 0x5553_4247, "batch magic 'USBG'");
    assert_eq!(header(4), 1, "batch version 1");
    assert_eq!(header(8), 3, "slot count");

    let slots = material_batch_slots(&bytes);
    assert_eq!(slots.len(), 3);
    for (path, (status, payload)) in paths.iter().zip(slots) {
        assert_eq!(status, 0, "{} should be an ok slot", path);
        let batched: MaterialInfo =
            serde_json::from_slice(&payload).expect("ok slot is MaterialInfo JSON");
        let per_path = request_material_data(&state.sender(), path).expect("per-path material");
        assert_eq!(
            batched, per_path,
            "{} slot mirrors the per-path fetch",
            path
        );
    }
}

#[test]
fn material_batch_fails_soft_per_slot() {
    // A bad path becomes an error slot without aborting the batch; the ok
    // slot before it still decodes as JSON.
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let paths = vec!["/World/PlasticBall".to_string(), "/World/Nope".to_string()];
    let bytes = request_material_batch(&state.sender(), &paths).expect("batch should frame");

    let slots = material_batch_slots(&bytes);
    assert_eq!(slots.len(), 2);

    let (status, payload) = &slots[0];
    assert_eq!(*status, 0, "first slot: ok");
    let info: MaterialInfo = serde_json::from_slice(payload).expect("ok slot is MaterialInfo JSON");
    assert_eq!(info.name, "Plastic");

    let (status, payload) = &slots[1];
    assert_eq!(*status, 1, "missing prim: error slot");
    let error = String::from_utf8_lossy(payload);
    assert!(
        error.contains("/World/Nope"),
        "error names the path: {}",
        error
    );
}

#[test]
fn empty_material_batch_frames_zero_slots() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_scene.usda");

    let bytes = request_material_batch(&state.sender(), &[]).expect("empty batch");

    assert_eq!(bytes.len(), 12, "header only");
    assert_eq!(
        u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
        0x5553_4247
    );
    assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 0);
}

#[test]
fn material_batch_without_open_stage_fails() {
    // No stage open means id 0 — the id lookup guards every command shape,
    // the batch command included.
    let state = spawn_stage_owner();
    assert_eq!(state.state.sender(0).unwrap_err(), "no stage 0");
}

#[test]
fn unauthored_wrap_transform_and_scale_default_to_identity() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "material_tiling.usda");

    let info =
        request_material_data(&state.sender(), "/World/PlainBall").expect("plain material data");
    let surface = info.surface.expect("Plain is a UsdPreviewSurface");
    assert_eq!(surface.textures.len(), 1);
    let texture = &surface.textures[0];
    assert_eq!(texture.wrap_s, None, "unauthored wrapS stays None");
    assert_eq!(texture.wrap_t, None);
    assert_eq!(
        texture.color_space, None,
        "unauthored sourceColorSpace stays None"
    );
    assert_eq!(
        texture.uv_transform, None,
        "no st connection means no transform"
    );
    assert_eq!(texture.value_scale, None);
    assert_eq!(texture.value_bias, None);
    assert_eq!(texture.st_primvar, "st", "no st connection defaults to st");
}

// UDIM tessellation over udim_scene.usda: a texture input whose file names a
// tile pattern enumerates its sibling tiles, a numbered literal enumerates the
// same set, and everything else stays plain.
fn only_texture(state: &common::TestOwner, path: &str) -> TextureInput {
    let mut textures = surface_of(state, path).textures;
    assert_eq!(textures.len(), 1, "{} has one texture input", path);
    textures.remove(0)
}

fn tile_path(name: &str) -> PathBuf {
    std::fs::canonicalize(fixture(name)).expect("fixture tile")
}

#[test]
fn udim_token_pattern_serializes_every_sibling_tile() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "udim_scene.usda");

    let texture = only_texture(&state, "/World/UdimPlane");
    assert_eq!(texture.input, "diffuseColor");
    assert_eq!(
        texture.file_path, "./tex.<UDIM>.png",
        "the raw spelling keeps the authored pattern"
    );
    let tiles = texture
        .udim_tiles
        .as_ref()
        .expect("a UDIM pattern enumerates its tiles");
    let seen: Vec<(u32, &Path)> = tiles
        .iter()
        .map(|tile| (tile.tile, Path::new(&tile.file_path)))
        .collect();
    assert_eq!(
        seen,
        vec![
            (1001, tile_path("tex.1001.png").as_path()),
            (1002, tile_path("tex.1002.png").as_path())
        ],
        "both tiles, sorted, resolved to the sibling files"
    );

    // The tiles ride the payload as authored JSON, not only as Rust fields.
    let json = serde_json::to_value(&texture).expect("texture serializes");
    assert_eq!(json["udim_tiles"][0]["tile"], serde_json::json!(1001));
    assert_eq!(
        json["udim_tiles"][1]["file_path"],
        serde_json::json!(tiles[1].file_path),
        "the payload carries each tile's resolved path"
    );
}

#[test]
fn udim_numbered_literal_enumerates_the_same_tiles_as_the_token() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "udim_scene.usda");

    let token = only_texture(&state, "/World/UdimPlane");
    let literal = only_texture(&state, "/World/LiteralPlane");
    assert!(
        literal.file_path.ends_with("tex.1001.png"),
        "the literal spelling is kept verbatim: {}",
        literal.file_path
    );
    let tiles = literal
        .udim_tiles
        .as_ref()
        .expect("a numbered tile still enumerates the set");
    assert_eq!(
        literal.udim_tiles, token.udim_tiles,
        "a literal tile in range is the same UDIM set as the token form"
    );
    assert_eq!(
        tiles.iter().map(|tile| tile.tile).collect::<Vec<_>>(),
        vec![1001, 1002]
    );
}

#[test]
fn plain_texture_answers_no_udim_tiles() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "udim_scene.usda");

    let texture = only_texture(&state, "/World/ControlPlane");
    assert!(
        texture.file_path.ends_with("checker.png"),
        "the control texture is a plain file: {}",
        texture.file_path
    );
    assert_eq!(
        texture.udim_tiles, None,
        "a plain png is not a UDIM pattern"
    );
}

#[test]
fn udim_pattern_without_siblings_answers_none() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "udim_scene.usda");

    let texture = only_texture(&state, "/World/NoHitsPlane");
    assert_eq!(
        texture.file_path, "./absent.<UDIM>.png",
        "the authored spelling survives a pattern with no hits"
    );
    assert_eq!(
        texture.udim_tiles, None,
        "no sibling matches: absent tiles, never an error"
    );
}
