use std::collections::HashMap;
use std::fmt;

use openusd::gf;
use openusd::sdf::{self, AssetPath, ListOp, Value, ValueTypeName};
use openusd::usd::{Attribute, Prim, Stage, TimeCode};
use serde::{Deserialize, Serialize};

/// One resolved USD value as a tagged union: `type` names the value family
/// (bool, int, uint, int64, uint64, float, double, half, string, token,
/// assetpath, matrix4d, vec2f/2d, vec3i/f/d, vec4f/d, quatf, quatd, color3f,
/// color3d, path_array, plus `<family>_array` for every array), `data` holds
/// the JSON encoding: numbers, strings, arrays (row-major 16 numbers for
/// matrix4d), `null` when unauthored.
///
/// Extensions beyond the brief's families (uchar, timecode, quath, half
/// vectors, matrix2d/3d, color4f/d) use their USD spelling so no known value
/// degrades to `unsupported`. `unsupported` carries a string representation.
/// A scalar `path` never occurs: openusd 0.8 registers no scalar path value
/// type, only `path_array` (a `path[]`-valued attribute).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValuePayload {
    pub r#type: String,
    pub data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

/// A prim attribute with its value resolved at the queried time code
/// (including schema fallbacks). `authored` is false when no layer authored
/// a value; then `value` is either the schema fallback or `unauthored`.
/// `time: None` resolves the attribute's default value (not a time sample).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttributeInfo {
    pub name: String,
    pub type_name: String,
    pub variability: String,
    pub authored: bool,
    pub value: ValuePayload,
}

/// One variant set on a prim: its options and the authored selection
/// (None when nothing authored an opinion for the set).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariantSetInfo {
    pub name: String,
    pub authored_selection: Option<String>,
    pub options: Vec<String>,
}

/// Everything the inspector panel needs about one prim. `metadata` is a
/// list of (field, value) pairs — serialized as a JSON array of two-element
/// arrays so fields keep authoring order; the frontend mirror lives in
/// src/lib/stage/types.ts. Transforms are row-major 4x4 arrays (USD
/// convention: translation in the last row); a prim without an authored
/// `xformOpOrder` contributes the identity, and `None` is reserved for a
/// stack (this prim, or an ancestor for the world matrix) whose ops cannot
/// be evaluated — no data beats wrong data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrimDetails {
    pub path: String,
    pub type_name: String,
    pub kind: String,
    pub is_active: bool,
    pub is_instance: bool,
    pub is_abstract: bool,
    pub instance_of: Option<String>,
    pub attributes: Vec<AttributeInfo>,
    pub metadata: Vec<(String, ValuePayload)>,
    pub variant_sets: Vec<VariantSetInfo>,
    pub composition_arcs: Vec<String>,
    pub local_transform: Option<[f64; 16]>,
    pub world_transform: Option<[f64; 16]>,
}

pub fn unauthored() -> ValuePayload {
    ValuePayload {
        r#type: "unauthored".to_string(),
        data: serde_json::Value::Null,
        truncated: None,
        count: None,
    }
}

const MAX_ARRAY_ELEMENTS: usize = 4096;

fn nested_payload(payload: ValuePayload) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    object.insert("type".to_string(), serde_json::json!(payload.r#type));
    object.insert("data".to_string(), payload.data);
    if let Some(truncated) = payload.truncated {
        object.insert("truncated".to_string(), serde_json::json!(truncated));
    }
    if let Some(count) = payload.count {
        object.insert("count".to_string(), serde_json::json!(count));
    }
    serde_json::Value::Object(object)
}

fn bounded_payload(r#type: String, mut data: serde_json::Value) -> ValuePayload {
    let mut truncated = None;
    let mut count = None;
    if r#type.ends_with("_array") {
        if let Some(values) = data.as_array_mut() {
            if values.len() > MAX_ARRAY_ELEMENTS {
                count = Some(values.len());
                values.truncate(MAX_ARRAY_ELEMENTS);
                truncated = Some(true);
            }
        }
    }
    ValuePayload {
        r#type,
        data,
        truncated,
        count,
    }
}

/// The declared spelling for role-typed vectors: `color3f`/`color3d` (and
/// `color4f`/`color4d`) instead of the generic vec family.
fn vec_family(declared: Option<&ValueTypeName>, generic: &str) -> String {
    match declared {
        Some(name) if name.role() == Some(sdf::Role::Color) => name
            .scalar_type()
            .unwrap_or_else(|| name.clone())
            .as_str()
            .to_string(),
        _ => generic.to_string(),
    }
}

fn vec3_json(x: f64, y: f64, z: f64) -> serde_json::Value {
    serde_json::json!([x, y, z])
}

/// Pure USD value -> JSON tagged-union serializer. `declared` is the
/// attribute's declared type name, used only to distinguish role-typed
/// spellings (color3f/color3d) from the generic vector family; pass `None`
/// when no declaration exists (metadata, fallbacks without a schema).
pub fn serialize_payload(declared: Option<&ValueTypeName>, value: &Value) -> ValuePayload {
    let known: Option<(String, serde_json::Value)> = match value {
        Value::None | Value::ValueBlock => return unauthored(),
        Value::Bool(v) => Some(("bool".into(), serde_json::json!(v))),
        Value::BoolVec(v) => Some(("bool_array".into(), serde_json::json!(v))),
        Value::Uchar(v) => Some(("uchar".into(), serde_json::json!(v))),
        Value::UcharVec(v) => Some(("uchar_array".into(), serde_json::json!(v))),
        Value::Int(v) => Some(("int".into(), serde_json::json!(v))),
        Value::IntVec(v) => Some(("int_array".into(), serde_json::json!(v))),
        Value::Uint(v) => Some(("uint".into(), serde_json::json!(v))),
        Value::UintVec(v) => Some(("uint_array".into(), serde_json::json!(v))),
        Value::Int64(v) => Some(("int64".into(), serde_json::json!(v))),
        Value::Int64Vec(v) => Some(("int64_array".into(), serde_json::json!(v))),
        Value::Uint64(v) => Some(("uint64".into(), serde_json::json!(v))),
        Value::Uint64Vec(v) => Some(("uint64_array".into(), serde_json::json!(v))),
        Value::Half(v) => Some(("half".into(), serde_json::json!(v.to_f32()))),
        Value::HalfVec(v) => Some((
            "half_array".into(),
            serde_json::json!(v.iter().map(|h| h.to_f32()).collect::<Vec<_>>()),
        )),
        Value::Float(v) => Some(("float".into(), serde_json::json!(v))),
        Value::FloatVec(v) => Some(("float_array".into(), serde_json::json!(v))),
        Value::Double(v) => Some(("double".into(), serde_json::json!(v))),
        Value::DoubleVec(v) => Some(("double_array".into(), serde_json::json!(v))),
        Value::TimeCode(v) => Some(("timecode".into(), serde_json::json!(v.value()))),
        Value::TimeCodeVec(v) => Some((
            "timecode_array".into(),
            serde_json::json!(v.iter().map(|t| t.value()).collect::<Vec<_>>()),
        )),
        Value::String(v) => Some(("string".into(), serde_json::json!(v))),
        Value::StringVec(v) => Some(("string_array".into(), serde_json::json!(v))),
        Value::Token(v) => Some(("token".into(), serde_json::json!(v.as_str()))),
        Value::TokenVec(v) => Some((
            "token_array".into(),
            serde_json::json!(v.iter().map(|t| t.as_str()).collect::<Vec<_>>()),
        )),
        Value::AssetPath(v) => Some(("assetpath".into(), serde_json::json!(v.authored_path))),
        Value::AssetPathVec(v) => Some((
            "assetpath_array".into(),
            serde_json::json!(v.iter().map(|a| &a.authored_path).collect::<Vec<_>>()),
        )),
        Value::Quath(q) => Some((
            "quath".into(),
            serde_json::json!([q.w.to_f32(), q.x.to_f32(), q.y.to_f32(), q.z.to_f32()]),
        )),
        Value::Quatf(q) => Some(("quatf".into(), serde_json::json!([q.w, q.x, q.y, q.z]))),
        Value::Quatd(q) => Some(("quatd".into(), serde_json::json!([q.w, q.x, q.y, q.z]))),
        Value::QuathVec(v) => Some((
            "quath_array".into(),
            serde_json::json!(v
                .iter()
                .map(|q| [q.w.to_f32(), q.x.to_f32(), q.y.to_f32(), q.z.to_f32()])
                .collect::<Vec<_>>()),
        )),
        Value::QuatfVec(v) => Some((
            "quatf_array".into(),
            serde_json::json!(v.iter().map(|q| [q.w, q.x, q.y, q.z]).collect::<Vec<_>>()),
        )),
        Value::QuatdVec(v) => Some((
            "quatd_array".into(),
            serde_json::json!(v.iter().map(|q| [q.w, q.x, q.y, q.z]).collect::<Vec<_>>()),
        )),
        Value::Vec2h(v) => Some((
            vec_family(declared, "vec2h"),
            serde_json::json!([v.x.to_f32(), v.y.to_f32()]),
        )),
        Value::Vec2f(v) => Some((vec_family(declared, "vec2f"), serde_json::json!([v.x, v.y]))),
        Value::Vec2d(v) => Some((vec_family(declared, "vec2d"), serde_json::json!([v.x, v.y]))),
        Value::Vec2i(v) => Some((vec_family(declared, "vec2i"), serde_json::json!([v.x, v.y]))),
        Value::Vec3h(v) => Some((
            vec_family(declared, "vec3h"),
            vec3_json(
                v.x.to_f32() as f64,
                v.y.to_f32() as f64,
                v.z.to_f32() as f64,
            ),
        )),
        Value::Vec3f(v) => Some((
            vec_family(declared, "vec3f"),
            vec3_json(v.x as f64, v.y as f64, v.z as f64),
        )),
        Value::Vec3d(v) => Some((vec_family(declared, "vec3d"), vec3_json(v.x, v.y, v.z))),
        Value::Vec3i(v) => Some((
            vec_family(declared, "vec3i"),
            serde_json::json!([v.x, v.y, v.z]),
        )),
        Value::Vec4h(v) => Some((
            vec_family(declared, "vec4h"),
            serde_json::json!([v.x.to_f32(), v.y.to_f32(), v.z.to_f32(), v.w.to_f32()]),
        )),
        Value::Vec4f(v) => Some((
            vec_family(declared, "vec4f"),
            serde_json::json!([v.x, v.y, v.z, v.w]),
        )),
        Value::Vec4d(v) => Some((
            vec_family(declared, "vec4d"),
            serde_json::json!([v.x, v.y, v.z, v.w]),
        )),
        Value::Vec4i(v) => Some((
            vec_family(declared, "vec4i"),
            serde_json::json!([v.x, v.y, v.z, v.w]),
        )),
        Value::Vec2hVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec2h")),
            serde_json::json!(v
                .iter()
                .map(|v| [v.x.to_f32(), v.y.to_f32()])
                .collect::<Vec<_>>()),
        )),
        Value::Vec2fVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec2f")),
            serde_json::json!(v.iter().map(|v| [v.x, v.y]).collect::<Vec<_>>()),
        )),
        Value::Vec2dVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec2d")),
            serde_json::json!(v.iter().map(|v| [v.x, v.y]).collect::<Vec<_>>()),
        )),
        Value::Vec2iVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec2i")),
            serde_json::json!(v.iter().map(|v| [v.x, v.y]).collect::<Vec<_>>()),
        )),
        Value::Vec3hVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec3h")),
            serde_json::json!(v
                .iter()
                .map(|v| [v.x.to_f32(), v.y.to_f32(), v.z.to_f32()])
                .collect::<Vec<_>>()),
        )),
        Value::Vec3fVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec3f")),
            serde_json::json!(v
                .iter()
                .map(|v| [v.x as f64, v.y as f64, v.z as f64])
                .collect::<Vec<_>>()),
        )),
        Value::Vec3dVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec3d")),
            serde_json::json!(v.iter().map(|v| [v.x, v.y, v.z]).collect::<Vec<_>>()),
        )),
        Value::Vec3iVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec3i")),
            serde_json::json!(v.iter().map(|v| [v.x, v.y, v.z]).collect::<Vec<_>>()),
        )),
        Value::Vec4hVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec4h")),
            serde_json::json!(v
                .iter()
                .map(|v| [v.x.to_f32(), v.y.to_f32(), v.z.to_f32(), v.w.to_f32()])
                .collect::<Vec<_>>()),
        )),
        Value::Vec4fVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec4f")),
            serde_json::json!(v
                .iter()
                .map(|v| [v.x as f64, v.y as f64, v.z as f64, v.w as f64])
                .collect::<Vec<_>>()),
        )),
        Value::Vec4dVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec4d")),
            serde_json::json!(v.iter().map(|v| [v.x, v.y, v.z, v.w]).collect::<Vec<_>>()),
        )),
        Value::Vec4iVec(v) => Some((
            format!("{}_array", vec_family(declared, "vec4i")),
            serde_json::json!(v.iter().map(|v| [v.x, v.y, v.z, v.w]).collect::<Vec<_>>()),
        )),
        Value::Matrix2d(m) => Some(("matrix2d".into(), serde_json::json!(m.0))),
        Value::Matrix3d(m) => Some(("matrix3d".into(), serde_json::json!(m.0))),
        Value::Matrix4d(m) => Some(("matrix4d".into(), serde_json::json!(m.0))),
        Value::Matrix2dVec(v) => Some((
            "matrix2d_array".into(),
            serde_json::json!(v.iter().map(|m| m.0).collect::<Vec<_>>()),
        )),
        Value::Matrix3dVec(v) => Some((
            "matrix3d_array".into(),
            serde_json::json!(v.iter().map(|m| m.0).collect::<Vec<_>>()),
        )),
        Value::Matrix4dVec(v) => Some((
            "matrix4d_array".into(),
            serde_json::json!(v.iter().map(|m| m.0).collect::<Vec<_>>()),
        )),
        Value::PathVec(v) => Some((
            "path_array".into(),
            serde_json::json!(v.iter().map(|p| p.to_string()).collect::<Vec<_>>()),
        )),
        Value::Dictionary(values) | Value::UnregisteredDictionary(values) => Some((
            "dict".into(),
            serde_json::Value::Object(
                values
                    .iter()
                    .map(|(key, value)| {
                        (key.clone(), nested_payload(serialize_payload(None, value)))
                    })
                    .collect(),
            ),
        )),
        _ => None,
    };
    match known {
        Some((r#type, data)) => bounded_payload(r#type, data),
        // Exotic values (list ops, payloads, expressions) and unregistered
        // spellings degrade to a readable string representation
        // instead of failing the whole details payload.
        None => ValuePayload {
            r#type: "unsupported".to_string(),
            data: serde_json::Value::String(string_repr(value)),
            truncated: None,
            count: None,
        },
    }
}

/// The payload's number for the floating families: any JSON number that
/// `as_f64` accepts (half rounding happens at the f16 conversion).
fn payload_number(payload: &ValuePayload) -> Result<f64, String> {
    payload
        .data
        .as_f64()
        .ok_or_else(|| format!("{} value is not a number", payload.r#type))
}

/// The payload's whole (integer) number as i64, refusing anything that does
/// not round-trip: floats, fractions, and integers beyond i64.
fn payload_whole(payload: &ValuePayload) -> Result<i64, String> {
    payload.data.as_i64().ok_or_else(|| {
        format!(
            "{} value is not a whole number in i64 range: {}",
            payload.r#type, payload.data
        )
    })
}

/// `payload_whole` bounded to `[min, max]`: out-of-range values are refused
/// instead of wrapping into the target integer family.
fn whole_in_range(payload: &ValuePayload, min: i64, max: i64) -> Result<i64, String> {
    let value = payload_whole(payload)?;
    if value < min || value > max {
        return Err(format!(
            "{} value {} is out of range {}-{}",
            payload.r#type, value, min, max
        ));
    }
    Ok(value)
}

fn payload_string(payload: &ValuePayload) -> Result<String, String> {
    payload
        .data
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("{} value is not a string", payload.r#type))
}

fn as_bool(payload: &ValuePayload) -> Result<bool, String> {
    payload
        .data
        .as_bool()
        .ok_or_else(|| format!("{} value is not a boolean", payload.r#type))
}

/// Reverse of `serialize_payload`: a ValuePayload back into an `sdf::Value`.
/// Only the scalar families the inspector can edit convert — bool, the
/// integer and floating scalars (incl. half and timecode), string, token,
/// assetpath — plus the vec3 and token-array families the transform
/// gizmo authors (float3/double3 accept both the declared USD spelling and
/// the serializer's generic vec3f/vec3d). Every other family (matrices,
/// dicts, path arrays) is a readable "not editable yet" error: better a
/// clear refusal than a silent wrong-kind authoring.
pub fn value_payload_to_sdf(payload: &ValuePayload) -> Result<Value, String> {
    let not_editable = || format!("type not editable yet: {}", payload.r#type);
    Ok(match payload.r#type.as_str() {
        "bool" => Value::Bool(as_bool(payload)?),
        "uchar" => Value::Uchar(whole_in_range(payload, 0, u8::MAX as i64)? as u8),
        "int" => Value::Int(whole_in_range(payload, i32::MIN as i64, i32::MAX as i64)? as i32),
        "uint" => Value::Uint(whole_in_range(payload, 0, u32::MAX as i64)? as u32),
        "int64" => Value::Int64(whole_in_range(payload, i64::MIN, i64::MAX)?),
        // u64 exceeds i64, so this family reads the JSON number exactly as
        // unsigned; negatives and fractions refuse.
        "uint64" => {
            let value = payload.data.as_u64().ok_or_else(|| {
                format!(
                    "uint64 value is not a whole number in u64 range: {}",
                    payload.data
                )
            })?;
            Value::Uint64(value)
        }
        "half" => Value::Half(gf::f16::from_f32(payload_number(payload)? as f32)),
        "float" => Value::Float(payload_number(payload)? as f32),
        "double" => Value::Double(payload_number(payload)?),
        "timecode" => Value::TimeCode(sdf::TimeCode(payload_number(payload)?)),
        "string" => Value::String(payload_string(payload)?),
        "token" => Value::Token(payload_string(payload)?.into()),
        "assetpath" => Value::AssetPath(AssetPath::new(payload_string(payload)?)),
        "float3" | "vec3f" => {
            let (x, y, z) = payload_vec3(payload)?;
            Value::Vec3f(gf::Vec3f {
                x: x as f32,
                y: y as f32,
                z: z as f32,
            })
        }
        "double3" | "vec3d" => {
            let (x, y, z) = payload_vec3(payload)?;
            Value::Vec3d(gf::Vec3d { x, y, z })
        }
        "token_array" => Value::TokenVec(
            payload
                .data
                .as_array()
                .ok_or_else(|| format!("token_array value is not a list: {}", payload.data))?
                .iter()
                .map(|item| {
                    item.as_str()
                        .ok_or_else(|| format!("token_array entry is not a string: {}", item))
                        .map(|token| token.to_owned().into())
                })
                .collect::<Result<Vec<_>, String>>()?,
        ),
        _ => return Err(not_editable()),
    })
}

/// The payload's [x, y, z] numbers (vec3 families).
fn payload_vec3(payload: &ValuePayload) -> Result<(f64, f64, f64), String> {
    let items = payload
        .data
        .as_array()
        .ok_or_else(|| format!("{} value is not a [x, y, z] list", payload.r#type))?;
    if items.len() != 3 {
        return Err(format!(
            "{} value needs exactly 3 components, got {}",
            payload.r#type,
            items.len()
        ));
    }
    let mut out = [0.0; 3];
    for (index, item) in items.iter().enumerate() {
        out[index] = item
            .as_f64()
            .ok_or_else(|| format!("{} component {} is not a number", payload.r#type, index))?;
    }
    Ok((out[0], out[1], out[2]))
}

fn string_repr(value: &Value) -> String {
    match value {
        Value::UnregisteredValue(repr) => repr.clone(),
        other => format!("{:?}", other),
    }
}

fn list_op_items<T: Default + Clone + PartialEq>(op: &ListOp<T>) -> Vec<T> {
    op.explicit_items
        .iter()
        .chain(&op.prepended_items)
        .chain(&op.appended_items)
        .cloned()
        .collect()
}

fn push_unique(arcs: &mut Vec<String>, arc: String) {
    if !arcs.contains(&arc) {
        arcs.push(arc);
    }
}

fn err(error: impl fmt::Display) -> String {
    format!("failed to compose prim details: {}", error)
}

const PRIM_METADATA_FIELDS: &[&str] = &[
    "documentation",
    "customData",
    "assetInfo",
    "hidden",
    "active",
    "instanceable",
    "apiSchemas",
];

/// Pure details serializer, mirroring `serialize_tree`: reads one prim's
/// composed state at `time` (`None` = default time, not a time sample).
/// Fails only on composition errors; unknown value kinds never fail.
pub fn serialize_details(
    stage: &Stage,
    path: &str,
    time: Option<f64>,
) -> Result<PrimDetails, String> {
    let prim_path =
        sdf::try_into_path(path).map_err(|e| format!("invalid prim path '{}': {}", path, e))?;
    let prim = stage.prim(prim_path).map_err(err)?;
    if !prim.is_valid().map_err(err)? {
        return Err(format!("prim not found: {}", path));
    }

    let attributes = prim
        .attributes()
        .map_err(err)?
        .iter()
        .map(|attribute| attribute_info(attribute, time))
        .collect::<Result<Vec<_>, String>>()?;

    // A metadata field the schema registry cannot decode is skipped, not
    // fatal: the inspector still shows everything else.
    let metadata = PRIM_METADATA_FIELDS
        .iter()
        .filter_map(|key| {
            prim.get_metadata::<Value>(key)
                .ok()
                .flatten()
                .map(|value| (key.to_string(), serialize_payload(None, &value)))
        })
        .collect();

    let instance_of = prim
        .prototype()
        .map_err(err)?
        .map(|prototype| prototype.to_string());

    Ok(PrimDetails {
        path: prim.path().to_string(),
        type_name: prim
            .type_name()
            .map_err(err)?
            .map(|token| token.to_string())
            .unwrap_or_default(),
        kind: prim
            .kind()
            .map_err(err)?
            .map(|token| token.to_string())
            .unwrap_or_default(),
        is_active: prim.is_active().map_err(err)?,
        is_instance: prim.is_instance().map_err(err)?,
        is_abstract: prim.is_abstract().map_err(err)?,
        instance_of,
        attributes,
        metadata,
        variant_sets: variant_sets(stage, &prim)?,
        composition_arcs: composition_arcs(stage, &prim),
        local_transform: local_transform(&prim, time)?.map(|matrix| matrix.0),
        world_transform: world_transform(&prim, time)?,
    })
}

fn attribute_info(attribute: &Attribute, time: Option<f64>) -> Result<AttributeInfo, String> {
    let declared = attribute.type_name().map_err(err)?;
    let variability = match attribute.variability().map_err(err)? {
        Some(sdf::Variability::Uniform) => "uniform".to_string(),
        _ => "varying".to_string(),
    };
    // Resolves the composed value at `time`, schema fallback included:
    // an attribute nothing authored and no schema declares resolves to
    // None, which reads back as `unauthored`.
    let value = match attribute
        .value_at::<Value>(time.map(TimeCode::new))
        .map_err(err)?
    {
        Some(value) => serialize_payload(declared.as_ref(), &value),
        None => unauthored(),
    };
    Ok(AttributeInfo {
        name: attribute.name().to_string(),
        type_name: declared
            .map(|name| name.as_str().to_string())
            .unwrap_or_default(),
        variability,
        authored: attribute.has_authored_value().map_err(err)?,
        value,
    })
}

fn variant_sets(stage: &Stage, prim: &Prim) -> Result<Vec<VariantSetInfo>, String> {
    // Set names come from two sources: the composed `variantSetNames`
    // metadata (which openusd resolves strongest-statement-first, so a layer
    // authoring two statements keeps only the last) and the contributing
    // layers' `variantSetChildren` specs — the same field the composition
    // engine walks — which is complete for every set with authored variants.
    let mut names: Vec<String> = Vec::new();
    if let Ok(Some(Value::StringListOp(op))) =
        stage.field::<Value>(prim.path().clone(), "variantSetNames")
    {
        for name in list_op_items(&op) {
            push_unique(&mut names, name);
        }
    }
    for name in layer_token_children(prim, "variantSetChildren", "") {
        push_unique(&mut names, name);
    }
    let authored: HashMap<String, String> =
        match stage.field::<Value>(prim.path().clone(), "variantSelection") {
            Ok(Some(Value::VariantSelectionMap(map))) => map,
            _ => HashMap::new(),
        };
    Ok(names
        .into_iter()
        .map(|name| VariantSetInfo {
            authored_selection: authored.get(&name).cloned(),
            options: layer_token_children(prim, "variantChildren", &name),
            name,
        })
        .collect())
}

/// Token-children fields of the prim's contributing layer specs, unioned in
/// strength order. `children_field` is a `ChildrenKey` spelling read at
/// `site.path` (plus `{set=}` for `variantChildren` when `set` is non-empty).
/// shortcut: a layer that cannot be re-opened is skipped, so children may be
/// incomplete for exotic layer sources; upgrade if the crate grows a
/// composed variant-options API.
fn layer_token_children(prim: &Prim, children_field: &str, set: &str) -> Vec<String> {
    let mut children: Vec<String> = Vec::new();
    let Ok(sites) = prim.prim_stack() else {
        return children;
    };
    for site in sites {
        let Ok(layer) = sdf::Layer::open(&site.layer) else {
            continue;
        };
        let spec_path = if set.is_empty() {
            site.path.clone()
        } else {
            match site.path.append_variant_selection(set, "") {
                Ok(path) => path,
                Err(_) => continue,
            }
        };
        let Ok(Some(value)) = layer.data().try_field(&spec_path, children_field) else {
            continue;
        };
        if let Value::TokenVec(tokens) = value.as_ref() {
            for token in tokens {
                let child = token.as_str().to_string();
                if !children.contains(&child) {
                    children.push(child);
                }
            }
        }
    }
    children
}

/// Human-readable composition arc summaries, read from the composed list-op
/// metadata fields: `references: @asset.usda@</Prim>`, `payload: ...`,
/// `inherits: </Class>`, `specializes: </Class>`. Variant selections have
/// their own `variant_sets` section and are not repeated here.
fn composition_arcs(stage: &Stage, prim: &Prim) -> Vec<String> {
    let mut arcs = Vec::new();
    let path = prim.path().clone();

    if let Ok(Some(Value::ReferenceListOp(op))) = stage.field::<Value>(path.clone(), "references") {
        for reference in list_op_items(&op) {
            push_unique(
                &mut arcs,
                format!(
                    "references: @{}@{}",
                    reference.asset_path, reference.prim_path
                ),
            );
        }
    }
    if let Ok(Some(Value::PayloadListOp(op))) = stage.field::<Value>(path.clone(), "payload") {
        for payload in list_op_items(&op) {
            push_unique(
                &mut arcs,
                format!("payload: @{}@{}", payload.asset_path, payload.prim_path),
            );
        }
    }
    for (field, label) in [("inheritPaths", "inherits"), ("specializes", "specializes")] {
        if let Ok(Some(Value::PathListOp(op))) = stage.field::<Value>(path.clone(), field) {
            for inherited in list_op_items(&op) {
                push_unique(&mut arcs, format!("{}: {}", label, inherited));
            }
        }
    }
    arcs
}

/// The prim's local transform from its `xformOpOrder` at `time`
/// (`None` = default time). The identity when the prim authors no
/// xformOpOrder (a plain prim is at the origin, so it stays editable);
/// `None` when an op cannot be evaluated (no data beats wrong data).
/// openusd 0.8 core ships no xform cache (that is openusd-schemas
/// territory), so the ops are evaluated here: matrices are row-major and
/// row-vector (`v' = v * M`), so each op in xformOpOrder pre-multiplies the
/// accumulator, giving the USD contract that the first listed op applies
/// last.
pub fn local_transform(prim: &Prim, time: Option<f64>) -> Result<Option<gf::Matrix4d>, String> {
    Ok(match compose_xform(prim, time)? {
        ComposedXform::NoOps => Some(gf::Matrix4d::IDENTITY),
        ComposedXform::Unsupported => None,
        ComposedXform::Matrix(matrix) => Some(matrix),
    })
}

/// The outcome of composing a prim's `xformOpOrder`.
enum ComposedXform {
    /// No `xformOpOrder` authored: the prim contributes the identity.
    NoOps,
    Matrix(gf::Matrix4d),
    /// Ops are authored but at least one cannot be evaluated.
    Unsupported,
}

/// The outcome of evaluating a single xform op.
#[derive(Debug)]
enum OpOutcome {
    Matrix(gf::Matrix4d),
    /// The op names a real attribute that has no value at the requested
    /// time (e.g. a time-sampled op queried at default time).
    NoValue,
    /// The op name or its value type is outside the evaluator's coverage.
    Unrecognized,
}

fn compose_xform(prim: &Prim, time: Option<f64>) -> Result<ComposedXform, String> {
    let order = prim
        .attribute("xformOpOrder")
        .get_at::<Value>(time.map(TimeCode::new))
        .map_err(err)?;
    let Some(Value::TokenVec(ops)) = order else {
        return Ok(ComposedXform::NoOps);
    };
    let mut acc = gf::Matrix4d::IDENTITY;
    for op in ops {
        let op = op.as_str();
        if op == "!resetXformStack!" {
            acc = gf::Matrix4d::IDENTITY;
            continue;
        }
        let outcome = op_transform(prim, op, time)?;
        match outcome {
            OpOutcome::Matrix(matrix) => acc = matrix * acc,
            ref other => {
                eprintln!("{}", xform_warning(op, &prim.path().to_string(), other));
                return Ok(ComposedXform::Unsupported);
            }
        }
    }
    Ok(ComposedXform::Matrix(acc))
}

fn xform_warning(op: &str, path: &str, outcome: &OpOutcome) -> String {
    let reason = match outcome {
        OpOutcome::NoValue => "has no value at the requested time",
        OpOutcome::Unrecognized | OpOutcome::Matrix(_) => "is not supported",
    };
    format!("xform op {op} on {path} {reason}; reporting no transform")
}

/// Whether the prim's `xformOpOrder` contains `!resetXformStack!`.
fn resets_xform_stack(prim: &Prim, time: Option<f64>) -> Result<bool, String> {
    Ok(matches!(
        prim.attribute("xformOpOrder")
            .get_at::<Value>(time.map(TimeCode::new))
            .map_err(err)?,
        Some(Value::TokenVec(ops))
            if ops.iter().any(|op| op.as_str() == "!resetXformStack!")
    ))
}

/// Suffixed ops (`xformOp:translate:pivot`) evaluate as their base op, and
/// `!inverted!` entries evaluate as the inverse of their op's matrix (the
/// Maya pivot pattern pairs the two around the in-between ops).
fn op_transform(prim: &Prim, op: &str, time: Option<f64>) -> Result<OpOutcome, String> {
    let (op, invert) = match op
        .strip_prefix("!inverted!")
        .or_else(|| op.strip_prefix("!invert!"))
    {
        Some(op) => (op, true),
        None => (op, false),
    };
    let Some(name) = op.strip_prefix("xformOp:") else {
        return Ok(OpOutcome::Unrecognized);
    };
    let Some(value) = prim
        .attribute(op)
        .value_at::<Value>(time.map(TimeCode::new))
        .map_err(err)?
    else {
        return Ok(OpOutcome::NoValue);
    };
    let vec3 = |value: &Value| -> Option<[f64; 3]> {
        match value {
            Value::Vec3d(v) => Some([v.x, v.y, v.z]),
            Value::Vec3f(v) => Some([v.x as f64, v.y as f64, v.z as f64]),
            _ => None,
        }
    };
    let rotate = |axis: u8, degrees: f64| match axis {
        b'X' => gf::Matrix4d::rotation_x(degrees.to_radians()),
        b'Y' => gf::Matrix4d::rotation_y(degrees.to_radians()),
        _ => gf::Matrix4d::rotation_z(degrees.to_radians()),
    };
    let degrees = |value: &Value| -> Option<f64> {
        match value {
            Value::Double(d) => Some(*d),
            Value::Float(f) => Some(*f as f64),
            _ => None,
        }
    };
    // Suffixes (`xformOp:translate:pivot`) evaluate as the base op; the
    // decoded value and the matrix come from the base name alone.
    let base = name.split(':').next().unwrap_or(name);
    let matrix = match (base, &value) {
        ("translate", v) => vec3(v).map(gf::Matrix4d::translation),
        ("scale", v) => vec3(v).map(gf::Matrix4d::scale),
        ("rotateX", v) => degrees(v).map(|d| rotate(b'X', d)),
        ("rotateY", v) => degrees(v).map(|d| rotate(b'Y', d)),
        ("rotateZ", v) => degrees(v).map(|d| rotate(b'Z', d)),
        // rotateZYX & friends: the first axis named is the most local (USD
        // xformOp.h), so in the row-vector convention its matrix is
        // leftmost and each axis uses its own vec3 component, in degrees.
        (name, v) if name.starts_with("rotate") && name.len() == "rotate".len() + 3 => {
            let order = &name.as_bytes()["rotate".len()..];
            if !order.iter().all(|axis| matches!(axis, b'X' | b'Y' | b'Z')) {
                return Ok(OpOutcome::Unrecognized);
            }
            let Some([x, y, z]) = vec3(v) else {
                return Ok(OpOutcome::Unrecognized);
            };
            let angle = |axis: u8| match axis {
                b'X' => x,
                b'Y' => y,
                _ => z,
            };
            let mut matrix = rotate(order[0], angle(order[0]));
            matrix = matrix * rotate(order[1], angle(order[1]));
            Some(matrix * rotate(order[2], angle(order[2])))
        }
        ("orient", Value::Quatf(q)) => Some(gf::Matrix4d::from_quat([
            q.w as f64, q.x as f64, q.y as f64, q.z as f64,
        ])),
        ("orient", Value::Quatd(q)) => Some(gf::Matrix4d::from_quat([q.w, q.x, q.y, q.z])),
        ("transform", Value::Matrix4d(matrix)) => Some(*matrix),
        _ => None,
    };
    match (matrix, invert) {
        (Some(matrix), false) => Ok(OpOutcome::Matrix(matrix)),
        // A singular op matrix has no inverse; treat it as unrecognized
        // rather than dropping the inversion.
        (Some(matrix), true) => Ok(matrix
            .inverse()
            .map_or(OpOutcome::Unrecognized, OpOutcome::Matrix)),
        (None, _) => Ok(OpOutcome::Unrecognized),
    }
}

/// The prim's world transform: its local transform composed with every
/// ancestor's (identity for ancestors without xformOpOrder), stopping at a
/// prim that resets the xform stack (it does not inherit ancestor
/// transforms). The identity when no prim in the chain authors an
/// xformOpOrder (a plain prim is still somewhere trustworthy in the world);
/// `None` when an op in the chain cannot be evaluated — the gizmo gate
/// reads that as a genuinely unsupported stack.
fn world_transform(prim: &Prim, time: Option<f64>) -> Result<Option<[f64; 16]>, String> {
    let mut chain = Vec::new();
    let mut current = Some(prim.clone());
    while let Some(ancestor) = current {
        current = ancestor.parent();
        let resets = resets_xform_stack(&ancestor, time)?;
        chain.push(ancestor);
        if resets {
            break;
        }
    }
    let mut acc = gf::Matrix4d::IDENTITY;
    for ancestor in chain.iter().rev() {
        match compose_xform(ancestor, time)? {
            ComposedXform::NoOps => {}
            ComposedXform::Matrix(matrix) => acc = matrix * acc,
            // An unevaluable ancestor would make the composed world wrong.
            ComposedXform::Unsupported => return Ok(None),
        }
    }
    Ok(Some(acc.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openusd::gf;
    use openusd::sdf::{AssetPath, Value, ValueTypeName};
    use serde_json::json;

    fn payload(declared: Option<&ValueTypeName>, value: &Value) -> ValuePayload {
        serialize_payload(declared, value)
    }

    fn scalar(name: &str) -> ValueTypeName {
        ValueTypeName::find(name).unwrap_or_else(|| panic!("{} is a registered type", name))
    }

    #[test]
    fn scalars_map_to_their_family() {
        assert_eq!(payload(None, &Value::Bool(true)).data, json!(true));
        assert_eq!(payload(None, &Value::Bool(true)).r#type, "bool");
        assert_eq!(payload(None, &Value::Int(-3)).r#type, "int");
        assert_eq!(payload(None, &Value::Int(-3)).data, json!(-3));
        assert_eq!(payload(None, &Value::Uint(3)).r#type, "uint");
        assert_eq!(payload(None, &Value::Int64(-4)).r#type, "int64");
        assert_eq!(payload(None, &Value::Uint64(4)).r#type, "uint64");
        assert_eq!(payload(None, &Value::Float(1.5)).r#type, "float");
        assert_eq!(payload(None, &Value::Float(1.5)).data, json!(1.5));
        assert_eq!(payload(None, &Value::Double(2.5)).r#type, "double");
        assert_eq!(payload(None, &Value::Uchar(9)).r#type, "uchar");
    }

    #[test]
    fn half_loses_no_information() {
        let payload = payload(Some(&scalar("half")), &Value::Half(gf::f16::from_f32(0.5)));
        assert_eq!(payload.r#type, "half");
        assert_eq!(payload.data, json!(0.5));
    }

    #[test]
    fn strings_tokens_and_assets() {
        assert_eq!(payload(None, &Value::String("hi".into())).r#type, "string");
        assert_eq!(payload(None, &Value::String("hi".into())).data, json!("hi"));
        let token = Value::Token("up".into());
        assert_eq!(payload(None, &token).r#type, "token");
        assert_eq!(payload(None, &token).data, json!("up"));
        let asset = Value::AssetPath(AssetPath::new("./asset.usda"));
        assert_eq!(payload(Some(&scalar("asset")), &asset).r#type, "assetpath");
        assert_eq!(
            payload(Some(&scalar("asset")), &asset).data,
            json!("./asset.usda")
        );
    }

    #[test]
    fn vectors_and_quaternions() {
        assert_eq!(
            payload(None, &Value::Vec2f(gf::Vec2f { x: 1.0, y: 2.0 })).r#type,
            "vec2f"
        );
        assert_eq!(
            payload(None, &Value::Vec2d(gf::Vec2d { x: 1.0, y: 2.0 })).data,
            json!([1.0, 2.0])
        );
        assert_eq!(
            payload(None, &Value::Vec3i(gf::Vec3i { x: 1, y: 2, z: 3 })).r#type,
            "vec3i"
        );
        assert_eq!(
            payload(None, &Value::Vec3i(gf::Vec3i { x: 1, y: 2, z: 3 })).data,
            json!([1, 2, 3])
        );
        assert_eq!(
            payload(None, &Value::Vec4f(gf::Vec4f::default())).r#type,
            "vec4f"
        );
        assert_eq!(
            payload(None, &Value::Vec4d(gf::Vec4d::default())).r#type,
            "vec4d"
        );
    }

    #[test]
    fn color_role_refines_the_vec_family() {
        let red = Value::Vec3f(gf::Vec3f {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
        assert_eq!(payload(Some(&scalar("color3f")), &red).r#type, "color3f");
        assert_eq!(payload(None, &red).r#type, "vec3f");
        let dark = Value::Vec3d(gf::Vec3d {
            x: 0.1,
            y: 0.1,
            z: 0.1,
        });
        assert_eq!(payload(Some(&scalar("color3d")), &dark).r#type, "color3d");
    }

    #[test]
    fn quaternions_carry_w_first() {
        let quat = Value::Quatf(gf::Quatf {
            w: 1.0,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        });
        let quat_payload = payload(None, &quat);
        assert_eq!(quat_payload.r#type, "quatf");
        assert_eq!(quat_payload.data, json!([1.0, 0.0, 0.0, 0.0]));
        let quatd = Value::Quatd(gf::Quatd {
            w: 0.0,
            x: 1.0,
            y: 0.0,
            z: 0.0,
        });
        assert_eq!(payload(None, &quatd).r#type, "quatd");
    }

    #[test]
    fn matrices_are_row_major() {
        let matrix = Value::Matrix4d(gf::Matrix4d::translation([1.0, 2.0, 3.0]));
        let matrix_payload = payload(None, &matrix);
        assert_eq!(matrix_payload.r#type, "matrix4d");
        assert_eq!(matrix_payload.data.as_array().map(Vec::len), Some(16));
        assert_eq!(
            matrix_payload.data,
            json!(gf::Matrix4d::translation([1.0, 2.0, 3.0]).0)
        );
    }

    #[test]
    fn arrays_append_the_array_suffix() {
        assert_eq!(
            payload(None, &Value::IntVec(vec![1, 2])).r#type,
            "int_array"
        );
        assert_eq!(
            payload(None, &Value::IntVec(vec![1, 2])).data,
            json!([1, 2])
        );
        assert_eq!(
            payload(None, &Value::FloatVec(vec![1.0])).r#type,
            "float_array"
        );
        assert_eq!(
            payload(
                Some(&scalar("color3f[]")),
                &Value::Vec3fVec(vec![gf::Vec3f {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0
                }])
            )
            .r#type,
            "color3f_array"
        );
        let paths = Value::PathVec(vec!["/World/Ball".parse().unwrap()]);
        assert_eq!(payload(None, &paths).r#type, "path_array");
        assert_eq!(payload(None, &paths).data, json!(["/World/Ball"]));
    }

    #[test]
    fn large_arrays_are_bounded_and_report_their_total_count() {
        let values = Value::FloatVec((0..5000).map(|value| value as f32).collect());
        let payload = payload(None, &values);

        assert_eq!(payload.r#type, "float_array");
        assert_eq!(payload.data.as_array().map(Vec::len), Some(4096));
        assert_eq!(payload.truncated, Some(true));
        assert_eq!(payload.count, Some(5000));
        assert!(
            serde_json::to_string(&payload)
                .expect("payload serializes")
                .len()
                < 32_768
        );
    }

    #[test]
    fn dictionaries_serialize_as_recursive_objects() {
        let dictionary = Value::Dictionary(
            [
                ("style".to_string(), Value::String("flat".into())),
                ("priority".to_string(), Value::Int(2)),
            ]
            .into_iter()
            .collect(),
        );
        let payload = payload(None, &dictionary);
        assert_eq!(payload.r#type, "dict");
        assert_eq!(
            payload.data,
            json!({
                "style": { "type": "string", "data": "flat" },
                "priority": { "type": "int", "data": 2 }
            })
        );
    }

    #[test]
    fn exotic_values_never_abort() {
        let payload = payload(None, &Value::UnregisteredValue("opaque".into()));
        assert_eq!(payload.r#type, "unsupported");
        assert_eq!(payload.data, json!("opaque"));
    }

    #[test]
    fn op_transform_distinguishes_no_value_from_unsupported_ops() {
        let stage = xforms_stage();
        let time_orient = stage
            .prim("/World/TimeOrient")
            .unwrap_or_else(|e| panic!("/World/TimeOrient resolvable: {e}"));
        // Samples are authored at 1s+ only, so default time has no value: a
        // distinct outcome from an op the evaluator cannot decode.
        assert!(matches!(
            op_transform(&time_orient, "xformOp:orient", None).unwrap(),
            OpOutcome::NoValue
        ));
        assert!(
            xform_warning("xformOp:orient", "/World/TimeOrient", &OpOutcome::NoValue)
                .contains("no value at the requested time")
        );

        let unsupported = stage
            .prim("/World/Unsupported")
            .unwrap_or_else(|e| panic!("/World/Unsupported resolvable: {e}"));
        assert!(matches!(
            op_transform(&unsupported, "xformOp:flip", None).unwrap(),
            OpOutcome::Unrecognized
        ));
        assert!(xform_warning(
            "xformOp:flip",
            "/World/Unsupported",
            &OpOutcome::Unrecognized
        )
        .contains("not supported"));
    }

    #[test]
    fn op_transform_evaluates_the_orient_at_its_authored_time_only() {
        let stage = xforms_stage();
        let prim = stage
            .prim("/World/TimeOrient")
            .unwrap_or_else(|e| panic!("/World/TimeOrient resolvable: {e}"));
        assert!(local_transform(&prim, None).unwrap().is_none());
        // quat (cos45, 0, 0, sin45) rotates Z by 90 degrees.
        let matrix = local_transform(&prim, Some(1.0))
            .unwrap()
            .expect("the quaternion evaluates at its sample");
        assert_close(
            &[
                0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            &matrix.0,
        );
    }

    #[test]
    fn op_transform_pairs_rotate_abc_components_by_axis_name() {
        let stage = xforms_stage();
        let prim = stage
            .prim("/World/TripletZYXAngles")
            .unwrap_or_else(|e| panic!("/World/TripletZYXAngles resolvable: {e}"));
        // rotateZYX (0, 90, 90): the vec's X component rotates about X and
        // its Z component about Z (axis-NAME pairing, the USD rotateABC
        // contract), multiplied in letter order with the first-named letter
        // leftmost: Rz(90)·Ry(90)·Rx(0), hand-computed row-major. A
        // positional pairing (Z->v0, X->v2) would compose a different
        // matrix, and the TS mirror in xformOps.ts depends on this one.
        let matrix = local_transform(&prim, None)
            .unwrap()
            .expect("the distinct-angle triplet evaluates");
        assert_close(
            &[
                0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            &matrix.0,
        );
    }

    #[test]
    fn op_transform_decodes_float_valued_rotation_degrees() {
        let stage = xforms_stage();
        let prim = stage
            .prim("/World/FloatRotate")
            .unwrap_or_else(|e| panic!("/World/FloatRotate resolvable: {e}"));
        let matrix = op_transform(&prim, "xformOp:rotateY", None).unwrap();
        let OpOutcome::Matrix(matrix) = matrix else {
            panic!("float rotateY evaluates: {matrix:?}")
        };
        assert_close(
            &gf::Matrix4d::rotation_y(90.0_f64.to_radians()).0,
            &matrix.0,
        );
    }

    fn xforms_stage() -> Stage {
        let path = format!("{}/tests/fixtures/xforms.usda", env!("CARGO_MANIFEST_DIR"));
        Stage::open(&path).expect("xforms.usda opens")
    }

    fn assert_close(expected: &[f64; 16], actual: &[f64; 16]) {
        for (i, (e, a)) in expected.iter().zip(actual).enumerate() {
            assert!((e - a).abs() < 1e-6, "element {i}: expected {e}, got {a}");
        }
    }

    #[test]
    fn blocks_and_missing_values_are_unauthored() {
        assert_eq!(payload(None, &Value::ValueBlock).r#type, "unauthored");
        assert_eq!(payload(None, &Value::None).r#type, "unauthored");
        assert_eq!(payload(None, &Value::ValueBlock).data, json!(null));
    }

    #[test]
    fn payload_to_sdf_round_trips_the_editable_scalars() {
        let cases = [
            ("bool", json!(true), Value::Bool(true)),
            ("uchar", json!(9), Value::Uchar(9)),
            ("int", json!(-3), Value::Int(-3)),
            ("uint", json!(3), Value::Uint(3)),
            ("int64", json!(-4), Value::Int64(-4)),
            ("uint64", json!(4), Value::Uint64(4)),
            ("half", json!(0.5), Value::Half(gf::f16::from_f32(0.5))),
            ("float", json!(1.5), Value::Float(1.5)),
            ("double", json!(2.5), Value::Double(2.5)),
            (
                "timecode",
                json!(10.0),
                Value::TimeCode(sdf::TimeCode(10.0)),
            ),
            ("string", json!("hi"), Value::String("hi".into())),
            ("token", json!("up"), Value::Token("up".into())),
            (
                "assetpath",
                json!("./asset.usda"),
                Value::AssetPath(AssetPath::new("./asset.usda")),
            ),
        ];
        for (r#type, data, expected) in cases {
            let converted = value_payload_to_sdf(&ValuePayload {
                r#type: r#type.to_string(),
                data,
                truncated: None,
                count: None,
            })
            .unwrap_or_else(|e| panic!("{} should convert: {}", r#type, e));
            assert_eq!(converted, expected, "{}", r#type);
        }
    }

    #[test]
    fn payload_to_sdf_refuses_out_of_range_integers() {
        let cases = [
            ("uchar", json!(256)),
            ("uchar", json!(-1)),
            ("int", json!(2147483648i64)),
            ("int", json!(-2147483649i64)),
            ("uint", json!(4294967296i64)),
            ("uint", json!(-1)),
            ("int64", json!(9223372036854775808u64)),
            ("uint64", json!(-1)),
            ("uint64", json!(1.5)),
            // Fractions never author into an integer family.
            ("int", json!(2.5)),
            ("uchar", json!(1.0)),
        ];
        for (r#type, data) in cases {
            let error = value_payload_to_sdf(&ValuePayload {
                r#type: r#type.to_string(),
                data,
                truncated: None,
                count: None,
            })
            .expect_err("out-of-range integers must refuse instead of wrapping");
            assert!(error.contains(r#type), "{}: {}", r#type, error);
        }
    }

    #[test]
    fn payload_to_sdf_accepts_extreme_in_range_integers() {
        let cases = [
            ("uchar", json!(255), Value::Uchar(255)),
            ("uchar", json!(0), Value::Uchar(0)),
            ("int", json!(-2147483648), Value::Int(-2147483648)),
            ("int", json!(2147483647), Value::Int(2147483647)),
            ("uint", json!(4294967295u64), Value::Uint(4294967295)),
            (
                "int64",
                json!(-9223372036854775808i64),
                Value::Int64(-9223372036854775808),
            ),
            (
                "int64",
                json!(9223372036854775807i64),
                Value::Int64(9223372036854775807),
            ),
            (
                "uint64",
                json!(18446744073709551615u64),
                Value::Uint64(18446744073709551615),
            ),
        ];
        for (r#type, data, expected) in cases {
            let converted = value_payload_to_sdf(&ValuePayload {
                r#type: r#type.to_string(),
                data,
                truncated: None,
                count: None,
            })
            .unwrap_or_else(|e| panic!("{} should convert: {}", r#type, e));
            assert_eq!(converted, expected, "{}", r#type);
        }
    }

    #[test]
    fn payload_to_sdf_refuses_non_scalars_and_bad_data() {
        for r#type in [
            "int_array",
            "float_array",
            "vec3f",
            "matrix4d",
            "dict",
            "unauthored",
        ] {
            let error = value_payload_to_sdf(&ValuePayload {
                r#type: r#type.to_string(),
                data: json!(null),
                truncated: None,
                count: None,
            })
            .expect_err("non-scalar families must refuse");
            assert!(error.contains(r#type), "{}", error);
        }
        let error = value_payload_to_sdf(&ValuePayload {
            r#type: "float".to_string(),
            data: json!("abc"),
            truncated: None,
            count: None,
        })
        .expect_err("a non-number where a float belongs must refuse");
        assert!(error.contains("float"), "{}", error);
    }
}
