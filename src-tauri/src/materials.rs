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
/// are `None` (the converter applies three.js defaults); inputs this task
/// does not model are skipped on the Rust side, never errors.
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
/// feeding it. `st_primvar` keeps the reader's name even when nothing feeds the
/// terminal, so it always names the primvar a map would read.
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
    let Some(source) = terminal.sources().first() else {
        return Ok(None);
    };
    let producers = match source.attribute() {
        ShadingAttribute::Input(input) => input.value_producing_attributes(ProducerFilter::Any),
        ShadingAttribute::Output(output) => output.value_producing_attributes(ProducerFilter::Any),
    };
    let mut displacement = Displacement {
        scale: None,
        file_path: None,
        st_primvar: "st".to_string(),
    };
    match channel_from_producers(producers)? {
        Some(Channel::Constant(value)) => displacement.scale = scalar(&value),
        Some(Channel::Texture(texture)) => {
            displacement.file_path = texture_file(&texture.file_input())?;
            displacement.st_primvar = st_primvar(&texture)?;
        }
        None => {}
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
        // The universal terminal was already tried above.
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
    channel_from_producers(input.value_producing_attributes(ProducerFilter::Any))
}

/// The channel a producer walk answers: a `UsdUVTexture` output anywhere in the
/// walk wins, else an authored value, else nothing. A refused walk (cycle,
/// depth budget) drops the channel.
fn channel_from_producers(
    producers: Result<Vec<ShadingAttribute>, openusd_schemas::SchemaError>,
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
                if constant.is_none() && attribute.has_authored_value().map_err(err)? {
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
        specular_color: color_payload(
            &surface.specular_color_input(),
            surface.specular_color().map_err(err)?,
        )?,
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
    let Some(file_path) = texture_file(&texture.file_input())? else {
        return Ok(None);
    };
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
    }))
}

/// The texture's `inputs:file`: an asset path (resolved to an absolute,
/// frontend-fetchable path by value resolution when the file exists, the
/// authored spelling otherwise) or a legacy string, tolerated verbatim.
/// shortcut: other spellings are skipped; never an error for a missing file
fn texture_file(input: &Input) -> Result<Option<String>, String> {
    Ok(match authored(input)? {
        Some(Value::AssetPath(asset)) => Some(match asset.resolved_path() {
            Some(resolved) => resolved.to_string(),
            None => asset.authored_path,
        }),
        Some(Value::String(path)) => Some(path),
        _ => None,
    })
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
/// is the input's declared one, colour3f when it declares none.
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
}
