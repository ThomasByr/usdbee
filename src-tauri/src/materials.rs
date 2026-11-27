//! UsdShade material introspection (Phase 2, Task 3): one composed Material
//! (or a mesh's bound material) -> `MaterialInfo` for the viewport. Pure over
//! openusd types — no Tauri types; in the app this runs inside the
//! stage-owner thread (stage.rs `GetMaterial` arm).
//!
//! Fail-soft everywhere: unknown shader ids, unknown inputs and missing
//! texture files degrade to absent data, never errors. Only a broken path
//! or a composition failure is an `Err`.

use openusd::gf;
use openusd::sdf::{self, Value};
use openusd::usd::{Prim, SchemaBase, Stage};
use openusd_schemas::shade::nodes::{PreviewSurface as UsdPreviewSurface, Transform2d, UVTexture};
use openusd_schemas::shade::{
    AttributeType, Connectable, Input, Material, MaterialBindingAPI, ProducerFilter, Shader,
    ShadingAttribute,
};
use serde::{Deserialize, Serialize};

use crate::parser::display_path;
use crate::values::{serialize_payload, ValuePayload};

/// One serialized material: the material prim's name and its
/// UsdPreviewSurface, if it has one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MaterialInfo {
    pub name: String,
    pub surface: Option<PreviewSurface>,
    #[serde(default)]
    pub displacement: Option<Displacement>,
    #[serde(default)]
    pub has_volume: bool,
}

/// The UsdPreviewSurface channels the viewport consumes. Unauthored channels
/// fold the USD node definition's defaults (no three.js default applies to a
/// found UsdPreviewSurface); inputs this task does not model are skipped on the
/// Rust side, never errors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PreviewSurface {
    pub diffuse_color: Option<ValuePayload>,
    pub roughness: Option<f64>,
    pub metallic: Option<f64>,
    pub opacity: Option<f64>,
    pub normal: Option<TextureInfo>,
    pub textures: Vec<TextureInput>,
    #[serde(default)]
    pub emissive_color: Option<ValuePayload>,
    #[serde(default)]
    pub specular_color: Option<ValuePayload>,
    #[serde(default)]
    pub clearcoat: Option<f64>,
    #[serde(default)]
    pub clearcoat_roughness: Option<f64>,
    #[serde(default)]
    pub opacity_threshold: Option<f64>,
    #[serde(default)]
    pub ior: Option<f64>,
    #[serde(default)]
    pub occlusion: Option<f64>,
}

/// The Material's displacement terminal: a `scale` from an authored constant on
/// the resolved output, or the `file_path`/`st_primvar` of a UsdUVTexture
/// feeding it. `st_primvar` is the reader primvar name; a `Some(Displacement)`
/// always carries a scale or a file path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Displacement {
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub file_path: Option<String>,
    pub st_primvar: String,
}

/// The UsdTransform2d a texture's `inputs:st` connects to, serialized as the
/// crate's node definition composes it: `result = in * scale * rotate +
/// translation`, rotation counter-clockwise in degrees around the origin
/// (openusd-schemas shaderDefs.usda, "UsdTransform2d").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct UvTransform {
    pub scale: [f32; 2],
    pub translation: [f32; 2],
    pub rotation: f32,
}

/// A texture outside the per-input list (the normal map): its file path and
/// the primvar its UVs come from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TextureInfo {
    pub file_path: String,
    pub st_primvar: String,
    pub wrap_s: Option<String>,
    pub wrap_t: Option<String>,
    pub uv_transform: Option<UvTransform>,
    pub value_scale: Option<[f32; 4]>,
    pub value_bias: Option<[f32; 4]>,
    pub color_space: Option<String>,
}

/// One tile of a UDIM texture: the 4-digit tile number (1001, 1002, ...) and
/// the tile file, resolved to the frontend-fetchable path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct UdimTile {
    pub tile: u32,
    pub file_path: String,
}

/// One PreviewSurface input fed by a UsdUVTexture: the input name
/// ("diffuseColor", "normal", ...), the frontend-fetchable file path (or
/// the unresolved spelling when the file is missing — never an error), and
/// the primvar its UVs come from. `wrap_s`/`wrap_t` are the authored
/// inputs:wrapS/wrapT tokens (None = unauthored, i.e. "useMetadata");
/// `uv_transform` is the UsdTransform2d in the `st` chain, when any;
/// `value_scale`/`value_bias` are the authored inputs:scale/inputs:bias;
/// `color_space` is the authored inputs:sourceColorSpace token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TextureInput {
    pub input: String,
    pub file_path: String,
    pub st_primvar: String,
    pub wrap_s: Option<String>,
    pub wrap_t: Option<String>,
    pub uv_transform: Option<UvTransform>,
    pub value_scale: Option<[f32; 4]>,
    pub value_bias: Option<[f32; 4]>,
    pub color_space: Option<String>,
    /// The sibling tiles when the file names a UDIM pattern (the `<UDIM>`
    /// token) or one numbered tile (1001-1100), sorted by tile; None for a
    /// plain texture, a pattern with no siblings, or a directory that cannot
    /// be read.
    #[serde(default)]
    pub udim_tiles: Option<Vec<UdimTile>>,
}

fn err(error: impl std::fmt::Display) -> String {
    format!("failed to serialize material: {}", error)
}

/// How many UsdTransform2d hops an `st` chain is followed through.
const MAX_ST_HOPS: usize = 4;

/// Serialize the material for `path`. Controller resolution (Task 3): `path`
/// may be the mesh prim OR the material prim. A Material serializes directly;
/// any other prim resolves its bound Material (collections, purpose-specific
/// and ancestor bindings included) and serializes it. An unbound prim (or a
/// binding with no / non-Material target) answers the prim's own name with
/// `surface: None`.
pub fn material_info(stage: &Stage, path: &str) -> Result<MaterialInfo, String> {
    let prim_path =
        sdf::try_into_path(path).map_err(|e| format!("invalid prim path '{}': {}", path, e))?;
    let prim = stage.prim(prim_path).map_err(err)?;
    if !prim.is_valid().map_err(err)? {
        return Err(format!("prim not found: {}", path));
    }

    if let Some(material) = Material::from_prim(prim.clone()).map_err(err)? {
        return serialize_material(&material);
    }

    // Spec R1: the viewport renders the preview purpose, so that query comes
    // first; `full` then rescues a mesh bound only at full purpose.
    // shortcut: every purpose query folds the all-purpose fallback in, so an
    // all-purpose binding shadows a full-only one; upgrade if an asset shows it
    let binding = MaterialBindingAPI::from_prim_unchecked(prim.clone());
    let bound = match binding.compute_bound_material("preview").map_err(err)? {
        Some(material) => Some(material),
        None => binding.compute_bound_material("full").map_err(err)?,
    };
    let Some(material_path) = bound else {
        return Ok(unbound(&prim));
    };
    let material_prim = stage.prim(material_path).map_err(err)?;
    if !material_prim.is_valid().map_err(err)? {
        return Ok(unbound(&prim));
    }
    match Material::from_prim(material_prim).map_err(err)? {
        Some(material) => serialize_material(&material),
        // A binding to something that is not a Material fails soft
        None => Ok(unbound(&prim)),
    }
}

fn unbound(prim: &Prim) -> MaterialInfo {
    MaterialInfo {
        name: prim.path().name().unwrap_or_default().to_string(),
        surface: None,
        displacement: None,
        has_volume: false,
    }
}

fn serialize_material(material: &Material) -> Result<MaterialInfo, String> {
    Ok(MaterialInfo {
        name: material
            .prim()
            .path()
            .name()
            .unwrap_or_default()
            .to_string(),
        surface: surface(material)?,
        displacement: displacement(material)?,
        has_volume: material.compute_volume_source(&[]).map_err(err)?.is_some(),
    })
}

/// The Material's displacement terminal (spec R6). The terminal walk stops on
/// the shader output, so the texture or constant feeding it comes from walking
/// that output's own producers.
/// shortcut: only a float constant maps to `scale` and only a resolved asset
/// to `file_path`; upgrade if an asset authors a vector displacement or a map
/// whose file resolves nowhere
fn displacement(material: &Material) -> Result<Option<Displacement>, String> {
    let Some(terminal) = material.compute_displacement_source(&[]).map_err(err)? else {
        return Ok(None);
    };
    // Root the walk at the terminal itself: the terminal's attribute carries the
    // connection, so a texture reached through it counts as a producer whether
    // or not the texture authors a value (shade/utils.rs:115-118).
    let output = material
        .displacement_output_for(terminal.render_context().as_str())
        .map_err(err)?;
    let producers = output.value_producing_attributes(ProducerFilter::Any);
    let mut displacement = Displacement {
        scale: None,
        file_path: None,
        st_primvar: "st".to_string(),
    };
    match channel_from_producers(producers, true)? {
        Some(Channel::Constant(value)) => displacement.scale = scalar(&value),
        Some(Channel::Texture(texture)) => {
            displacement.file_path = texture_file(&texture.file_input())?;
            displacement.st_primvar = st_primvar(&texture)?;
        }
        None => {}
    }
    // Spec R6: an unsupported producer, or a constant that is no float, leaves
    // nothing to displace; a payload of absent fields is no displacement.
    if displacement.scale.is_none() && displacement.file_path.is_none() {
        return Ok(None);
    }
    Ok(Some(displacement))
}

/// The Material's surface terminal -> connected shader, serialized when it is
/// a UsdPreviewSurface. The universal terminal is preferred; a material that
/// only authors render-context terminals (`outputs:<ctx>:surface`) falls back
/// to the first of those that reaches a UsdPreviewSurface. Unknown shader ids
/// fail soft to `None`; displacement and volume terminals are ignored.
fn surface(material: &Material) -> Result<Option<PreviewSurface>, String> {
    if let Some(terminal) = material.compute_surface_source(&[]).map_err(err)? {
        if let Some(shader) = terminal
            .sources()
            .first()
            .and_then(|source| source.shader())
        {
            if let Some(preview) = UsdPreviewSurface::from_shader(shader.clone()).map_err(err)? {
                return Ok(Some(preview_surface(&preview)?));
            }
        }
    }
    for output in material.surface_outputs().map_err(err)? {
        // The universal terminal was already tried above. The bare "surface"
        // is the terminal name the crate classifies (shade/material.rs:406-411,
        // terminal_outputs), not a path to compare against.
        if output.base_name() == "surface" {
            continue;
        }
        for attribute in output
            .value_producing_attributes(ProducerFilter::ShaderOutputsOnly)
            .map_err(err)?
        {
            let Some(shader) = Shader::from_prim(attribute.attribute().prim()).map_err(err)? else {
                continue;
            };
            if let Some(preview) = UsdPreviewSurface::from_shader(shader.clone()).map_err(err)? {
                return Ok(Some(preview_surface(&preview)?));
            }
        }
    }
    Ok(None)
}

/// One PreviewSurface channel resolved through its producers (spec R3).
enum Channel {
    /// A constant: an authored interface input's value, or the input's own.
    Constant(Value),
    /// A `UsdUVTexture` feeding the channel. It outranks a constant on the
    /// same input whatever order the walk returns.
    Texture(UVTexture),
}

/// Resolve `input` through its producers (spec R3): a `UsdUVTexture` output
/// anywhere in the walk wins, else an authored interface value, else nothing.
/// An unsupported producer (a Multiply node's output) leaves the channel
/// absent, and so does a cycle or a chain past the crate's depth budget —
/// those answer an empty walk or a refusal, never a panic and never an error.
fn resolve_channel(input: &Input) -> Result<Option<Channel>, String> {
    channel_from_producers(input.value_producing_attributes(ProducerFilter::Any), false)
}

/// The channel a producer walk answers: a `UsdUVTexture` output anywhere in the
/// walk wins, else an authored value, else nothing. A refused walk (cycle,
/// depth budget) drops the channel. `fold_output_constants` admits an authored
/// value on a shader output, which only the displacement terminal needs: a
/// surface channel fed by an unsupported producer stays absent (spec R3).
fn channel_from_producers(
    producers: Result<Vec<ShadingAttribute>, openusd_schemas::SchemaError>,
    fold_output_constants: bool,
) -> Result<Option<Channel>, String> {
    let Ok(producers) = producers else {
        return Ok(None);
    };
    let mut constant = None;
    for producer in producers {
        let attribute = producer.attribute();
        match producer.attribute_type() {
            AttributeType::Output => {
                if let Some(shader) = Shader::from_prim(attribute.prim()).map_err(err)? {
                    if let Some(texture) = UVTexture::from_shader(shader).map_err(err)? {
                        return Ok(Some(Channel::Texture(texture)));
                    }
                }
                // A shader output may author a constant itself, as a
                // displacement signal does; an unauthored output is no value.
                if fold_output_constants
                    && constant.is_none()
                    && attribute.has_authored_value().map_err(err)?
                {
                    constant = attribute.value_at::<Value>(None).map_err(err)?;
                }
            }
            AttributeType::Input if constant.is_none() => {
                constant = attribute.value_at::<Value>(None).map_err(err)?;
            }
            AttributeType::Input => {}
        }
    }
    Ok(constant.map(Channel::Constant))
}

/// Whether an absent channel may take the node definition's default: nothing
/// is wired and nothing is authored, so the walk came back empty for want of a
/// producer rather than because it closed on a cycle or broke (spec R4).
fn folds_definition_default(input: &Input) -> Result<bool, String> {
    let attribute = input.attribute();
    Ok(attribute.connections().map_err(err)?.is_empty()
        && !attribute.has_authored_value().map_err(err)?)
}

fn preview_surface(surface: &UsdPreviewSurface) -> Result<PreviewSurface, String> {
    let mut textures = Vec::new();
    let mut normal = None;
    for input in surface.shader().inputs().map_err(err)? {
        let Some(Channel::Texture(texture)) = resolve_channel(&input)? else {
            continue;
        };
        let Some(entry) = texture_input(&input, &texture)? else {
            continue;
        };
        if entry.input == "normal" {
            normal = Some(TextureInfo {
                file_path: entry.file_path.clone(),
                st_primvar: entry.st_primvar.clone(),
                wrap_s: entry.wrap_s.clone(),
                wrap_t: entry.wrap_t.clone(),
                uv_transform: entry.uv_transform.clone(),
                value_scale: entry.value_scale,
                value_bias: entry.value_bias,
                color_space: entry.color_space.clone(),
            });
        }
        textures.push(entry);
    }
    Ok(PreviewSurface {
        diffuse_color: color_payload(
            &surface.diffuse_color_input(),
            surface.diffuse_color().map_err(err)?,
        )?,
        roughness: scalar_channel(
            &surface.roughness_input(),
            surface.roughness().map_err(err)?,
        )?,
        metallic: scalar_channel(&surface.metallic_input(), surface.metallic().map_err(err)?)?,
        opacity: scalar_channel(&surface.opacity_input(), surface.opacity().map_err(err)?)?,
        normal,
        textures,
        emissive_color: color_payload(
            &surface.emissive_color_input(),
            surface.emissive_color().map_err(err)?,
        )?,
        // shortcut: specularColor gets no definition default because USD gates its
        // (0,0,0) to the specular workflow; three's 0x111111 default already plays
        // the ior-derived dielectric F0 role, so a specular-workflow asset that
        // leaves it unauthored gets three's sheen instead of USD-true black.
        specular_color: color_payload(&surface.specular_color_input(), None)?,
        clearcoat: scalar_channel(
            &surface.clearcoat_input(),
            surface.clearcoat().map_err(err)?,
        )?,
        clearcoat_roughness: scalar_channel(
            &surface.clearcoat_roughness_input(),
            surface.clearcoat_roughness().map_err(err)?,
        )?,
        opacity_threshold: scalar_channel(
            &surface.opacity_threshold_input(),
            surface.opacity_threshold().map_err(err)?,
        )?,
        ior: scalar_channel(&surface.ior_input(), surface.ior().map_err(err)?)?,
        occlusion: scalar_channel(
            &surface.occlusion_input(),
            surface.occlusion().map_err(err)?,
        )?,
    })
}

fn texture_input(input: &Input, texture: &UVTexture) -> Result<Option<TextureInput>, String> {
    let file = texture.file_input();
    let Some(file_path) = texture_file(&file)? else {
        return Ok(None);
    };
    let udim_tiles = udim_tiles(&file, &file_path);
    Ok(Some(TextureInput {
        input: input.base_name().to_string(),
        file_path,
        st_primvar: st_primvar(texture)?,
        wrap_s: wrap_token(&texture.wrap_s_input())?,
        wrap_t: wrap_token(&texture.wrap_t_input())?,
        color_space: wrap_token(&texture.source_color_space_input())?,
        uv_transform: uv_transform(texture)?,
        value_scale: float4(&texture.scale_input())?,
        value_bias: float4(&texture.bias_input())?,
        udim_tiles,
    }))
}

/// The texture's `inputs:file`: an asset path (resolved to an absolute,
/// frontend-fetchable path by value resolution when the file exists, the
/// authored spelling otherwise) or a legacy string, tolerated verbatim.
/// shortcut: other spellings are skipped; never an error for a missing file
fn texture_file(input: &Input) -> Result<Option<String>, String> {
    Ok(match authored(input)? {
        Some(Value::AssetPath(asset)) => Some(match asset.resolved_path() {
            Some(resolved) => display_path(resolved),
            None => asset.authored_path,
        }),
        Some(Value::String(path)) => Some(path),
        _ => None,
    })
}

/// The authored placeholder for a UDIM tile number.
const UDIM_TOKEN: &str = "<UDIM>";

/// The 4-digit tile numbers a UDIM set spans: the 10x10 grid, 1001 to 1100.
const UDIM_TILES: std::ops::RangeInclusive<u32> = 1001..=1100;

/// A tile number: a whole 4-digit segment in range. Anything else (a plain
/// name, a longer or shorter run, a non-numeric segment) is no tile.
fn tile_number(segment: &str) -> Option<u32> {
    if segment.len() != 4 {
        return None;
    }
    let tile = segment.parse::<u32>().ok()?;
    UDIM_TILES.contains(&tile).then_some(tile)
}

/// The tile pattern `name` spells, as the text before and after the tile
/// number: the `<UDIM>` token when present (it wins wherever it sits), else a
/// dot-separated 4-digit run in tile range. None when the name is no pattern.
fn udim_pattern(name: &str) -> Option<(&str, &str)> {
    if let Some(at) = name.find(UDIM_TOKEN) {
        return Some((&name[..at], &name[at + UDIM_TOKEN.len()..]));
    }
    let mut start = 0;
    for segment in name.split('.') {
        let end = start + segment.len();
        if tile_number(segment).is_some() {
            return Some((&name[..start], &name[end..]));
        }
        start = end + 1;
    }
    None
}

/// The sibling tiles of a UDIM texture input, sorted by tile. The authored
/// path's own directory is listed when it is already absolute (the resolved
/// spelling); a relative one is anchored at the authoring layer's directory,
/// as value resolution would anchor it.
/// shortcut: a pattern with no readable siblings answers None, which leaves the
/// frontend on the authored spelling exactly as a missing file does today;
/// upgrade if an asset keeps its tiles outside the pattern's own directory
fn udim_tiles(input: &Input, file_path: &str) -> Option<Vec<UdimTile>> {
    let path = std::path::Path::new(file_path);
    let (prefix, suffix) = udim_pattern(path.file_name()?.to_str()?)?;
    let directory = udim_directory(input, path)?;
    let mut tiles: Vec<UdimTile> = std::fs::read_dir(directory)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let middle = name.to_str()?.strip_prefix(prefix)?.strip_suffix(suffix)?;
            let tile = tile_number(middle)?;
            let path = entry.path();
            // metadata follows a symlink, so a linked tile still counts while a
            // directory named like a tile (or a dangling or looping link) does not
            if !std::fs::metadata(&path).ok()?.is_file() {
                return None;
            }
            let file_path = std::fs::canonicalize(&path).unwrap_or(path);
            Some(UdimTile {
                tile,
                file_path: crate::parser::clean(&file_path.to_string_lossy()),
            })
        })
        .collect();
    if tiles.is_empty() {
        return None;
    }
    tiles.sort_by_key(|tile| tile.tile);
    Some(tiles)
}

/// The directory a UDIM pattern's tiles live in: the file's own parent when it
/// is absolute, else the directory of the layer that authored the asset path
/// joined with the authored relative parent. None when that layer has no
/// resolved location (an in-memory stage) — a fail-soft answer, never an error.
fn udim_directory(input: &Input, path: &std::path::Path) -> Option<std::path::PathBuf> {
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new(""));
    if parent.is_absolute() {
        return Some(parent.to_path_buf());
    }
    let attribute = input.attribute();
    let layer = attribute.resolve_info().ok()?.spec_site()?.layer.clone();
    let resolved = attribute
        .stage()
        .layer(&layer)?
        .resolved_path()
        .map(std::path::PathBuf::from)?;
    Some(resolved.parent()?.join(parent))
}

/// The primvar the texture's `inputs:st` chain reads (the primvar reader's
/// `inputs:varname`), "st" when the walk finds no reader. The walk reaches a
/// reader wrapped in a NodeGraph, and a UsdTransform2d between the texture and
/// the reader is hopped through its `inputs:in`.
fn st_primvar(texture: &UVTexture) -> Result<String, String> {
    let mut input = texture.st_input();
    // shortcut: a real st chain holds a hop or two; a longer one, or a cyclic
    // chain of transforms, answers the default instead of spinning
    for _ in 0..MAX_ST_HOPS {
        let Ok(producers) = input.value_producing_attributes(ProducerFilter::Any) else {
            return Ok("st".to_string());
        };
        let mut transform = None;
        for producer in producers {
            let Some(shader) = Shader::from_prim(producer.attribute().prim()).map_err(err)? else {
                continue;
            };
            if let Some(hop) = Transform2d::from_shader(shader.clone()).map_err(err)? {
                transform = Some(hop);
                break;
            }
            return varname(&shader);
        }
        let Some(hop) = transform else {
            return Ok("st".to_string());
        };
        input = hop.in_input();
    }
    Ok("st".to_string())
}

/// The reader's authored `inputs:varname`, "st" when unauthored.
fn varname(shader: &Shader) -> Result<String, String> {
    Ok(match authored(&shader.input("varname"))? {
        Some(Value::Token(name)) => name.as_str().to_string(),
        Some(Value::String(name)) => name,
        _ => "st".to_string(),
    })
}

/// The shader the texture's `inputs:st` connects to.
fn st_source(texture: &UVTexture) -> Result<Option<Shader>, String> {
    let Some(source) = texture
        .st_input()
        .connected_sources()
        .map_err(err)?
        .sources()
        .first()
        .cloned()
    else {
        return Ok(None);
    };
    Ok(Some(Shader::from_prim_unchecked(
        source.source_prim().clone(),
    )))
}

/// The UsdTransform2d in the texture's `st` chain: its scale/translation/
/// rotation, falling back to the node definition's identity values
/// ((1,1), (0,0), 0) when unauthored. None when `st` is not connected to a
/// UsdTransform2d at all.
fn uv_transform(texture: &UVTexture) -> Result<Option<UvTransform>, String> {
    let Some(shader) = st_source(texture)? else {
        return Ok(None);
    };
    let Some(transform) = Transform2d::from_shader(shader).map_err(err)? else {
        return Ok(None);
    };
    let scale = transform
        .scale()
        .map_err(err)?
        .unwrap_or_else(|| gf::vec2f(1.0, 1.0));
    let translation = transform
        .translation()
        .map_err(err)?
        .unwrap_or_else(|| gf::vec2f(0.0, 0.0));
    Ok(Some(UvTransform {
        scale: [scale[0], scale[1]],
        translation: [translation[0], translation[1]],
        rotation: transform.rotation().map_err(err)?.unwrap_or(0.0),
    }))
}

/// An authored wrap token ("repeat", "clamp", "mirror", "black",
/// "useMetadata"), None when unauthored.
fn wrap_token(input: &Input) -> Result<Option<String>, String> {
    Ok(match authored(input)? {
        Some(Value::Token(token)) => Some(token.as_str().to_string()),
        Some(Value::String(token)) => Some(token),
        _ => None,
    })
}

/// An authored float4 input's components; absent or other-typed values are
/// None.
fn float4(input: &Input) -> Result<Option<[f32; 4]>, String> {
    Ok(match authored(input)? {
        Some(Value::Vec4f(v)) => Some([v[0], v[1], v[2], v[3]]),
        _ => None,
    })
}

/// An input's authored value only, for the reads that must tell an authored
/// spelling from a defaulted one (texture file, wrap tokens, primvar name).
fn authored(input: &Input) -> Result<Option<Value>, String> {
    let attribute = input.attribute();
    if !attribute.has_authored_value().map_err(err)? {
        return Ok(None);
    }
    attribute.value_at::<Value>(None).map_err(err)
}

/// A scalar channel: a constant from the producer walk; a texture-fed or
/// unsupported/cyclic input is absent; the node definition's default folds in
/// only when nothing is wired and nothing authored (spec R4).
fn scalar_channel(input: &Input, definition_default: Option<f32>) -> Result<Option<f64>, String> {
    Ok(match resolve_channel(input)? {
        Some(Channel::Constant(value)) => scalar(&value),
        Some(Channel::Texture(_)) => None,
        None => {
            let (Some(default), true) = (definition_default, folds_definition_default(input)?)
            else {
                return Ok(None);
            };
            Some(default as f64)
        }
    })
}

/// A scalar USD value widened to f64; absent or non-numeric values are None.
fn scalar(value: &Value) -> Option<f64> {
    match value {
        Value::Float(v) => Some(*v as f64),
        Value::Double(v) => Some(*v),
        Value::Half(v) => Some(v.to_f32() as f64),
        _ => None,
    }
}

/// A colour channel payload, resolved like `scalar_channel`; the payload's type
/// is the input's declared one, colour3f when it declares none. A `None`
/// definition default makes the channel authored-only.
fn color_payload(
    input: &Input,
    definition_default: Option<gf::Vec3f>,
) -> Result<Option<ValuePayload>, String> {
    let value = match resolve_channel(input)? {
        Some(Channel::Constant(value)) => value,
        Some(Channel::Texture(_)) => return Ok(None),
        None => {
            let (Some(default), true) = (definition_default, folds_definition_default(input)?)
            else {
                return Ok(None);
            };
            Value::Vec3f(default)
        }
    };
    let declared = input
        .attribute()
        .type_name()
        .map_err(err)?
        .unwrap_or(sdf::ValueTypeName::COLOR3F);
    Ok(Some(serialize_payload(Some(&declared), &value)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openusd_schemas::shade::NodeGraph;

    /// Spec R7: the `<UDIM>` token wins wherever it sits, a dot-separated
    /// 4-digit run in range is a pattern, and a plain name is none.
    #[test]
    fn udim_pattern_detection() {
        assert_eq!(udim_pattern("tex.<UDIM>.png"), Some(("tex.", ".png")));
        assert_eq!(udim_pattern("<UDIM>.png"), Some(("", ".png")));
        assert_eq!(
            udim_pattern("tex.1002.png"),
            Some(("tex.", ".png")),
            "a numbered literal is the same pattern"
        );
        assert_eq!(
            udim_pattern("tex.<UDIM>.1001.png"),
            Some(("tex.", ".1001.png"))
        );
        assert_eq!(
            udim_pattern("tex.1100.png"),
            Some(("tex.", ".png")),
            "1100 closes the 10x10 grid"
        );
        assert_eq!(udim_pattern("tex.1101.png"), None, "out of tile range");
        assert_eq!(udim_pattern("checker.png"), None);
        assert_eq!(udim_pattern("tex.10011.png"), None, "not a 4-digit run");
        assert_eq!(tile_number("1001"), Some(1001));
        assert_eq!(tile_number("1001.png"), None);
        assert_eq!(tile_number(""), None);
    }

    /// A chain past the producer walk's depth budget is refused, and the
    /// refusal drops the channel instead of failing the material (spec R3).
    /// The shape follows the crate's own `deep_chain_errors` test.
    #[test]
    fn depth_limit_drops_the_channel() -> openusd::Result<()> {
        let stage = Stage::builder()
            .schema_registry(openusd_schemas::schema_registry())
            .in_memory("depth.usda")?;
        let depth = 258;
        for hop in 0..depth {
            NodeGraph::define(&stage, format!("/Mat/N{hop}"))?.create_output("result", "float")?;
        }
        for hop in 0..depth - 1 {
            let next = stage.attribute(format!("/Mat/N{}.outputs:result", hop + 1))?;
            stage
                .attribute(format!("/Mat/N{hop}.outputs:result"))?
                .set_connections([next.path().clone()])?;
        }
        let surface = UsdPreviewSurface::define(&stage, "/Mat/Surface")?;
        surface
            .shader()
            .create_input("roughness", "float")?
            .set_connections([sdf::path("/Mat/N0.outputs:result")?])?;

        let input = surface.roughness_input();
        assert!(
            input
                .value_producing_attributes(ProducerFilter::Any)
                .is_err(),
            "the chain is past the walk's budget"
        );
        assert!(resolve_channel(&input)
            .expect("a refused walk drops the channel")
            .is_none());
        Ok(())
    }

    /// A stage with the schema registry, for authoring shading networks.
    fn stage(name: &str) -> openusd::Result<Stage> {
        Stage::builder()
            .schema_registry(openusd_schemas::schema_registry())
            .in_memory(name)
    }

    /// Spec R6: a displacement terminal whose producer is neither an authored
    /// constant nor a `UsdUVTexture` — or whose constant is a vector — answers
    /// `None`, not a payload with every field absent.
    #[test]
    fn displacement_all_null_fields_answer_none() -> openusd::Result<()> {
        let stage = stage("displacement.usda")?;

        // A Multiply-style producer authors no value of its own.
        let material = Material::define(&stage, "/Unsupported")?;
        let multiply = Shader::define(&stage, "/Unsupported/Multiply")?;
        multiply
            .create_id_attr()?
            .set(Value::token("UsdMultiply"))?;
        let result = multiply.create_output("result", "float")?;
        material.create_displacement_output()?.connect_to(&result)?;
        assert_eq!(
            material_info(&stage, "/Unsupported")
                .expect("material serializes")
                .displacement,
            None,
            "an unsupported producer is no displacement at all"
        );

        // A vector terminal fails soft too: `scale` is a float.
        let material = Material::define(&stage, "/Vector")?;
        let shader = Shader::define(&stage, "/Vector/Displace")?;
        let output = shader
            .create_output("displacement", "float3")?
            .set(gf::vec3f(0.0, 0.0, 0.05))?;
        material.create_displacement_output()?.connect_to(&output)?;
        assert_eq!(
            material_info(&stage, "/Vector")
                .expect("material serializes")
                .displacement,
            None,
            "vector displacement fails soft"
        );
        Ok(())
    }

    /// Spec R6: a `UsdUVTexture` feeding the displacement terminal serializes
    /// its file and the primvar reader's name, not just a constant scale. The
    /// texture output authors no value, the way real assets wire it: only the
    /// connection reaches it.
    #[test]
    fn textured_displacement_resolves_file_and_primvar() -> openusd::Result<()> {
        let stage = stage("displacement_texture.usda")?;
        let material = Material::define(&stage, "/TexDisp")?;
        let texture = UVTexture::define(&stage, "/TexDisp/Height")?;
        texture
            .shader()
            .create_input("file", "asset")?
            .set(Value::AssetPath(sdf::AssetPath::new("./checker.png")))?;
        let reader = Shader::define(&stage, "/TexDisp/st")?;
        reader
            .create_id_attr()?
            .set(Value::token("UsdPrimvarReader_float2"))?;
        reader
            .create_input("varname", "string")?
            .set(Value::String("uv".to_string()))?;
        let st = reader.create_output("result", "float2")?;
        texture
            .shader()
            .create_input("st", "float2")?
            .connect_to(&st)?;
        let height = texture.shader().create_output("r", "float")?;
        material.create_displacement_output()?.connect_to(&height)?;

        let displacement = material_info(&stage, "/TexDisp")
            .expect("material serializes")
            .displacement
            .expect("a texture-fed terminal is displacement");
        assert_eq!(displacement.scale, None, "a texture is no constant");
        assert!(
            displacement
                .file_path
                .expect("the texture file reaches the payload")
                .ends_with("checker.png"),
            "the texture's file resolves"
        );
        assert_eq!(
            displacement.st_primvar, "uv",
            "the reader names the primvar, not the fallback"
        );
        Ok(())
    }

    /// A NodeGraph interface input feeding `specularColor` still serializes as
    /// a constant: `color_payload`'s constant arm runs before the channel's
    /// suppressed definition-default fold.
    #[test]
    fn graph_interface_constant_feeds_specular_color() -> openusd::Result<()> {
        let stage = stage("specular_graph.usda")?;
        let material = Material::define(&stage, "/Mat")?;
        let surface = UsdPreviewSurface::define(&stage, "/Mat/Surface")?;
        let terminal = surface.shader().create_output("surface", "token")?;
        material.create_surface_output()?.connect_to(&terminal)?;

        let graph = NodeGraph::define(&stage, "/Mat/Graph")?;
        let authored = graph
            .create_input("spec", "color3f")?
            .set(gf::vec3f(0.2, 0.3, 0.4))?;
        let output = graph
            .create_output("specular", "color3f")?
            .connect_to(&authored)?;
        surface
            .shader()
            .create_input("specularColor", "color3f")?
            .connect_to(&output)?;

        let info = material_info(&stage, "/Mat").expect("material serializes");
        let surface = info.surface.expect("the surface terminal resolves");
        assert_eq!(
            surface
                .specular_color
                .expect("the graph-fed constant serializes")
                .data,
            serde_json::json!([0.2f32 as f64, 0.3f32 as f64, 0.4f32 as f64]),
            "an authored interface input is a constant, not a dropped channel"
        );
        Ok(())
    }

    /// Spec R3: a surface channel fed by a producer that is neither an authored
    /// interface input nor a `UsdUVTexture` output stays absent, even when that
    /// producer authors a value of its own (which only displacement folds).
    #[test]
    fn authored_shader_output_constant_does_not_leak_into_surface_channels() -> openusd::Result<()>
    {
        let stage = stage("shader_output.usda")?;
        let material = Material::define(&stage, "/Mat")?;
        let surface = UsdPreviewSurface::define(&stage, "/Mat/Surface")?;
        let terminal = surface.shader().create_output("surface", "token")?;
        let multiply = Shader::define(&stage, "/Mat/Multiply")?;
        multiply
            .create_id_attr()?
            .set(Value::token("UsdMultiply"))?;
        multiply.create_output("result", "float")?.set(3.0_f32)?;
        surface
            .shader()
            .create_input("roughness", "float")?
            .set_connections([sdf::path("/Mat/Multiply.outputs:result")?])?;
        material.create_surface_output()?.connect_to(&terminal)?;

        let info = material_info(&stage, "/Mat").expect("material serializes");
        let surface = info.surface.expect("the surface terminal resolves");
        assert_eq!(
            surface.roughness, None,
            "an unsupported producer leaves the channel absent (R3)"
        );
        Ok(())
    }
}
