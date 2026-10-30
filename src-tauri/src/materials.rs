//! UsdShade material introspection (Phase 2, Task 3): one composed Material
//! (or a mesh's bound material) -> `MaterialInfo` for the viewport. Pure over
//! openusd types — no Tauri types; in the app this runs inside the
//! stage-owner thread (stage.rs `GetMaterial` arm).
//!
//! Fail-soft everywhere: unknown shader ids, unknown inputs and missing
//! texture files degrade to absent data, never errors. Only a broken path
//! or a composition failure is an `Err`.

use openusd::sdf::{self, Value};
use openusd::usd::{Prim, SchemaBase, Stage};
use openusd_schemas::shade::nodes::{PreviewSurface as UsdPreviewSurface, UVTexture};
use openusd_schemas::shade::{Connectable, Input, Material, MaterialBindingAPI, Shader};
use serde::{Deserialize, Serialize};

use crate::values::{serialize_payload, ValuePayload};

/// One serialized material: the material prim's name and its
/// UsdPreviewSurface, if it has one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MaterialInfo {
    pub name: String,
    pub surface: Option<PreviewSurface>,
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
}

/// A texture outside the per-input list (the normal map): its file path and
/// the primvar its UVs come from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TextureInfo {
    pub file_path: String,
    pub st_primvar: String,
}

/// One PreviewSurface input fed by a UsdUVTexture: the input name
/// ("diffuseColor", "normal", ...), the frontend-fetchable file path (or
/// the unresolved spelling when the file is missing — never an error), and
/// the primvar its UVs come from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TextureInput {
    pub input: String,
    pub file_path: String,
    pub st_primvar: String,
}

fn err(error: impl std::fmt::Display) -> String {
    format!("failed to serialize material: {}", error)
}

/// Serialize the material for `path`. Controller resolution (Task 3): `path`
/// may be the mesh prim OR the material prim. A Material serializes directly;
/// any other prim resolves its direct `material:binding` relationship and
/// serializes the bound Material. An unbound prim (or a binding with no /
/// non-Material target) answers the prim's own name with `surface: None`.
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

    // shortcut: collection-based material bindings are out of scope; only a
    // direct all-purpose `material:binding` relationship is read
    let bound = MaterialBindingAPI::from_prim_unchecked(prim.clone())
        .direct_binding("")
        .map_err(err)?;
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
    })
}

/// The Material's surface terminal -> connected shader, serialized when it is
/// a UsdPreviewSurface. Unknown shader ids fail soft to `None`; displacement
/// and volume terminals are ignored.
/// shortcut: render-context-only surface terminals (outputs:<ctx>:surface)
/// are not consulted; only the universal terminal is
fn surface(material: &Material) -> Result<Option<PreviewSurface>, String> {
    let Some(terminal) = material.compute_surface_source(&[]).map_err(err)? else {
        return Ok(None);
    };
    let Some(source) = terminal.sources().first() else {
        return Ok(None);
    };
    let Some(shader) = source.shader() else {
        return Ok(None);
    };
    if UsdPreviewSurface::from_shader(shader.clone())
        .map_err(err)?
        .is_none()
    {
        return Ok(None);
    }
    Ok(Some(preview_surface(shader)?))
}

fn preview_surface(shader: &Shader) -> Result<PreviewSurface, String> {
    let mut textures = Vec::new();
    let mut normal = None;
    for input in shader.inputs().map_err(err)? {
        let Some(texture) = connected_texture(&input)? else {
            continue;
        };
        let Some(entry) = texture_input(&input, &texture)? else {
            continue;
        };
        if entry.input == "normal" {
            normal = Some(TextureInfo {
                file_path: entry.file_path.clone(),
                st_primvar: entry.st_primvar.clone(),
            });
        }
        textures.push(entry);
    }
    Ok(PreviewSurface {
        diffuse_color: color_payload(&shader.input("diffuseColor"))?,
        roughness: scalar(&shader.input("roughness"))?,
        metallic: scalar(&shader.input("metallic"))?,
        opacity: scalar(&shader.input("opacity"))?,
        normal,
        textures,
    })
}

/// The UsdUVTexture feeding `input`, when its connection resolves to one.
fn connected_texture(input: &Input) -> Result<Option<UVTexture>, String> {
    let Some(source) = input
        .connected_sources()
        .map_err(err)?
        .sources()
        .first()
        .cloned()
    else {
        return Ok(None);
    };
    let shader = Shader::from_prim_unchecked(source.source_prim().clone());
    UVTexture::from_shader(shader).map_err(err)
}

fn texture_input(input: &Input, texture: &UVTexture) -> Result<Option<TextureInput>, String> {
    let Some(file_path) = texture_file(&texture.file_input())? else {
        return Ok(None);
    };
    Ok(Some(TextureInput {
        input: input.base_name().to_string(),
        file_path,
        st_primvar: st_primvar(texture)?,
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

/// The primvar the texture's `inputs:st` connection reads (the primvar
/// reader's `inputs:varname`), "st" when absent.
fn st_primvar(texture: &UVTexture) -> Result<String, String> {
    let Some(source) = texture
        .st_input()
        .connected_sources()
        .map_err(err)?
        .sources()
        .first()
        .cloned()
    else {
        return Ok("st".to_string());
    };
    let reader = Shader::from_prim_unchecked(source.source_prim().clone());
    Ok(match authored(&reader.input("varname"))? {
        Some(Value::Token(name)) => name.as_str().to_string(),
        Some(Value::String(name)) => name,
        _ => "st".to_string(),
    })
}

/// An input's authored value only — the schema registry's node-definition
/// fallbacks (e.g. diffuseColor's 0.18 gray) are deliberately NOT folded in:
/// absent channels must stay `None` so the converter applies its own
/// defaults.
fn authored(input: &Input) -> Result<Option<Value>, String> {
    let attribute = input.attribute();
    if !attribute.has_authored_value().map_err(err)? {
        return Ok(None);
    }
    attribute.value_at::<Value>(None).map_err(err)
}

/// A scalar input widened to f64; absent or non-numeric values are `None`.
fn scalar(input: &Input) -> Result<Option<f64>, String> {
    Ok(match authored(input)? {
        Some(Value::Float(v)) => Some(v as f64),
        Some(Value::Double(v)) => Some(v),
        Some(Value::Half(v)) => Some(v.to_f32() as f64),
        _ => None,
    })
}

fn color_payload(input: &Input) -> Result<Option<ValuePayload>, String> {
    let Some(value) = authored(input)? else {
        return Ok(None);
    };
    let declared = input.attribute().type_name().map_err(err)?;
    Ok(Some(serialize_payload(declared.as_ref(), &value)))
}
