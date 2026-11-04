//! Tessellation (Phase 2, Tasks 1/5): one composed geometry prim ->
//! render-ready data. A pure function over the openusd `Prim` — no
//! Tauri types; in the app this runs inside the stage-owner thread.
//!
//! `Mesh` prims triangulate by fanning each face `(v0, vi, vi+1)` over
//! `faceVertexIndices` and `faceVertexCounts` (holes and bridging are out
//! of scope; subdivision meshes render their base hull). `BasisCurves`
//! prims tessellate to open 6-sided tubes (no end caps) with constant
//! widths; `Points` prims tessellate to a point cloud (indices empty);
//! `Sphere` prims tessellate analytically at a fixed 24×12 density.
//! Authored `normals`, `primvars:st` and `primvars:displayColor` are read
//! at the queried time code; for meshes unauthored normals are generated
//! as per-vertex area-weighted face-normal averages.

use openusd::gf::{Vec2f, Vec3f};
use openusd::sdf;
use openusd::usd::{Prim, SchemaBase, TimeCode};
use openusd_schemas::geom::{
    AttributeMetadata, Curves, CurvesSchema, Interpolation, Mesh, Points, Primvar,
};
use openusd_schemas::geom::{MeshSchema, PointBasedSchema};
use openusd_schemas::SchemaError;

use crate::skinning;

/// One tessellated mesh: positions keyed per vertex, `indices` spanning
/// triangles by vertex index, and per-vertex primvar arrays aligned with
/// `positions` (constant is replicated per vertex; faceVarying maps each
/// original vertex to its first corner's value; uniform maps each vertex to
/// its first surviving face's value).
#[derive(Debug, Clone, PartialEq)]
pub struct MeshData {
    pub positions: Vec<[f32; 3]>,
    pub normals: Option<Vec<[f32; 3]>>,
    pub uvs: Option<Vec<[f32; 2]>>,
    pub colors: Option<Vec<[f32; 3]>>,
    pub indices: Vec<u32>,
}

/// How a primvar's values lie on the surface; only the flavors this task can
/// map over a triangle soup are material, and anything that cannot map is
/// dropped rather than faked.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum Scope {
    Constant,
    Vertex,
    Uniform,
    FaceVarying,
}

impl From<Interpolation> for Scope {
    fn from(interp: Interpolation) -> Self {
        match interp {
            Interpolation::Constant => Scope::Constant,
            Interpolation::Vertex | Interpolation::Varying => Scope::Vertex,
            Interpolation::Uniform => Scope::Uniform,
            Interpolation::FaceVarying => Scope::FaceVarying,
        }
    }
}

impl Scope {
    // `normals` is not a primvar: its interpolation is plain attribute
    // metadata, and unauthored means vertex (C++ `GetNormalsInterpolation`).
    fn from_token(token: Option<&str>) -> Self {
        match token {
            Some("constant") => Scope::Constant,
            Some("uniform") => Scope::Uniform,
            Some("faceVarying") => Scope::FaceVarying,
            _ => Scope::Vertex,
        }
    }
}

fn context(path: &str, error: impl std::fmt::Display) -> String {
    format!("failed to tessellate {}: {}", path, error)
}

/// Tessellate one composed prim. `Ok(None)` for anything that is not
/// renderable geometry (Mesh, BasisCurves, Points, Sphere); `Err` names the prim
/// path when the geometry itself cannot be tessellated. `time: Some(t)`
/// reads time-sampled attributes at `t`; `None` reads the default-time
/// values.
pub fn tessellate_prim(prim: &Prim, time: Option<f64>) -> Result<Option<MeshData>, String> {
    let path = prim.path().to_string();
    // Typed views are registry-gated, and the stage owner registers the
    // schemas registry anyway; the straight type-name compare keeps the
    // dispatch readable alongside `from_prim_unchecked` (Task 1 precedent).
    let type_name = prim
        .type_name()
        .map_err(|e| context(&path, e))?
        .map(|t| t.to_string());
    let time_code = time.map(TimeCode::new);
    match type_name.as_deref() {
        Some("Mesh") => mesh_data(prim, time_code, &path),
        Some("BasisCurves") => curves_data(prim, time_code, &path),
        Some("Points") => points_data(prim, time_code, &path),
        Some("Sphere") => sphere_data(prim, time_code, &path),
        _ => Ok(None),
    }
}

fn mesh_data(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<MeshData>, String> {
    let mesh = Mesh::from_prim_unchecked(prim.clone());

    let mut points: Vec<Vec3f> = expect_value(mesh.points_at(time_code), "points", path)?;
    let counts: Vec<i32> = expect_value(
        mesh.face_vertex_counts_at(time_code),
        "faceVertexCounts",
        path,
    )?;
    let index_list: Vec<i32> = expect_value(
        mesh.face_vertex_indices_at(time_code),
        "faceVertexIndices",
        path,
    )?;

    // UsdSkel: skin the authored points (and vertex-scoped authored
    // normals) in place before anything else consumes them. A detected-
    // but-broken binding logs and renders unskinned — the same fail-soft
    // decision as the lossy normal sets below, never a dropped mesh.
    let mut authored_normals =
        normals_attr_values(&mesh, time_code).map_err(|e| context(path, e))?;
    let skin_normals = match &mut authored_normals {
        Some((scope, values)) if *scope == Scope::Vertex && values.len() == points.len() => {
            Some(values)
        }
        _ => None,
    };
    let normals_were_skinned = skin_normals.is_some();
    let points_were_skinned =
        match skinning::skin_mesh(prim, time_code.map(f64::from), &mut points, skin_normals) {
            Ok(skinned) => skinned,
            Err(e) => {
                eprintln!("skinning {}: {}", path, e);
                false
            }
        };
    // Bind-pose normals must never ship alongside skinned points: an
    // authored normal set this pass could not skin (non-vertex scope, or a
    // length that does not match the points) is discarded so the
    // generation below recomputes it from the deformed positions.
    if points_were_skinned && !normals_were_skinned {
        authored_normals = None;
    }

    // Non-finite positions cannot reach a GPU buffer: such vertices are
    // compacted away, surviving indices remap, and any face referencing a
    // dropped (or out-of-range) vertex contributes nothing at all. Finite
    // but zero-area fan triangles are filtered during triangulation below.
    let (positions, orig_to_new) = compact_points(&points);
    let vertex_count = points.len();

    // Face walk: (surviving original vertex, flat corner slot, authored face
    // id) triples feed the primvar scatter; the corner slot aligns with
    // flattened faceVarying arrays and the face id with uniform arrays,
    // regardless of drops.
    let mut corners: Vec<(u32, usize, usize)> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut cursor = 0usize;
    for (face_id, &count) in counts.iter().enumerate() {
        let count = count.max(0) as usize;
        let face = index_list.get(cursor..cursor + count).unwrap_or(&[]);
        cursor += count;
        // Faces with fewer than 3 vertices are degenerate and contribute no
        // indices; out-of-range faceVertexIndices entries skip the whole
        // face instead of panicking.
        let usable = count >= 3
            && face.len() == count
            && face.iter().all(|&v| {
                v >= 0 && (v as usize) < vertex_count && orig_to_new[v as usize].is_some()
            });
        if !usable {
            continue;
        }
        for (slot, &v) in face.iter().enumerate() {
            corners.push((v as u32, cursor - count + slot, face_id));
        }
        for i in 1..count - 1 {
            let triangle = [face[0], face[i], face[i + 1]]
                .map(|v| orig_to_new[v as usize].expect("face usability checked") as usize);
            let (a, b, c) = (
                positions[triangle[0]],
                positions[triangle[1]],
                positions[triangle[2]],
            );
            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let area = cross3(ab, ac);
            if area.iter().map(|value| value * value).sum::<f32>() > 0.0 {
                indices.extend(triangle.map(|index| index as u32));
            }
        }
    }

    // Authored normals first; nothing authored means generated ones (the
    // API cooperates, so generation landed in Task 1 instead of Task 5).
    // shortcut: an authored normal set that cannot map over the triangle
    // soup is dropped (normals: None) rather than falling back to generated
    // ones; revisit when the renderer cares about either lossy set.
    let normals = match authored_normals {
        Some((scope, values)) => meshable(scope, values, &corners, vertex_count, &orig_to_new)
            .map(|per_vertex| per_vertex.into_iter().map(|v| [v.x, v.y, v.z]).collect()),
        None => Some(generated_normals(&positions, &indices)),
    };

    let uvs = read_primvar::<Vec2f>(mesh.prim(), "primvars:st", time_code, path)?
        .and_then(|(scope, values)| meshable(scope, values, &corners, vertex_count, &orig_to_new))
        .map(|per_vertex| per_vertex.into_iter().map(|v| [v.x, v.y]).collect());
    let colors = read_primvar::<Vec3f>(mesh.prim(), "primvars:displayColor", time_code, path)?
        .and_then(|(scope, values)| meshable(scope, values, &corners, vertex_count, &orig_to_new))
        .map(|per_vertex| per_vertex.into_iter().map(|v| [v.x, v.y, v.z]).collect());

    Ok(Some(MeshData {
        positions,
        normals,
        uvs,
        colors,
        indices,
    }))
}

fn sphere_data(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<MeshData>, String> {
    const U: usize = 24;
    const V: usize = 12;
    // shortcut: fixed density keeps transfer costs predictable; add adaptive
    // density only if close-up sphere quality becomes a requirement.
    let radius = prim
        .attribute("radius")
        .get_at::<f64>(time_code)
        .map_err(|e| context(path, e))?
        .map(|radius| radius as f32)
        .filter(|radius| radius.is_finite() && *radius > 0.0)
        .unwrap_or(1.0);

    let mut positions = Vec::with_capacity((U + 1) * (V + 1));
    let mut normals = Vec::with_capacity(positions.capacity());
    let mut uvs = Vec::with_capacity(positions.capacity());
    for v in 0..=V {
        let phi = std::f32::consts::PI * v as f32 / V as f32;
        let (sin_phi, cos_phi) = phi.sin_cos();
        for u in 0..=U {
            let theta = std::f32::consts::TAU * u as f32 / U as f32;
            let (sin_theta, cos_theta) = theta.sin_cos();
            let normal = [sin_phi * cos_theta, cos_phi, sin_phi * sin_theta];
            positions.push(normal.map(|value| value * radius));
            normals.push(normal);
            uvs.push([u as f32 / U as f32, v as f32 / V as f32]);
        }
    }

    let mut indices = Vec::with_capacity(U * (2 * V - 2) * 3);
    for v in 0..V {
        for u in 0..U {
            let a = (v * (U + 1) + u) as u32;
            let b = a + (U + 1) as u32;
            let c = b + 1;
            let d = a + 1;
            if v == 0 {
                indices.extend_from_slice(&[a, c, b]);
            } else if v == V - 1 {
                indices.extend_from_slice(&[a, d, b]);
            } else {
                indices.extend_from_slice(&[a, d, b, d, c, b]);
            }
        }
    }

    let colors = read_primvar::<Vec3f>(prim, "primvars:displayColor", time_code, path)?.and_then(
        |(scope, values)| match scope {
            Scope::Constant => values
                .first()
                .map(|color| vec![[color.x, color.y, color.z]; positions.len()]),
            Scope::Vertex if values.len() == positions.len() => Some(
                values
                    .into_iter()
                    .map(|color| [color.x, color.y, color.z])
                    .collect(),
            ),
            _ => None,
        },
    );
    Ok(Some(MeshData {
        positions,
        normals: Some(normals),
        uvs: Some(uvs),
        colors,
        indices,
    }))
}

/// 6-sided tube cross-section (controller resolution).
const CURVE_SIDES: usize = 6;
/// Unauthored (or non-positive, non-finite) curve width fallback per the
/// brief: a constant width of 0.1 -> a 0.05 ring radius.
const DEFAULT_CURVE_WIDTH: f32 = 0.1;

fn curves_data(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<MeshData>, String> {
    let curves = Curves::from_prim_unchecked(prim.clone());
    let points: Vec<Vec3f> = expect_value(curves.points_at(time_code), "points", path)?;
    let counts: Vec<i32> = expect_value(
        curves.curve_vertex_counts_at(time_code),
        "curveVertexCounts",
        path,
    )?;
    // Constant interpolation only (controller resolution): one width value
    // rules the whole curve; vertex/curve-varying widths — or none — degrade
    // to the first value / the 0.1 default. shortcut: per-vertex width
    // detail is lost until the renderer needs tapered tubes.
    let width = curves
        .widths_at(time_code)
        .map_err(|e| context(path, e))?
        .into_iter()
        .flatten()
        .next();
    let radius = width
        .filter(|w| w.is_finite() && *w > 0.0)
        .unwrap_or(DEFAULT_CURVE_WIDTH)
        / 2.0;

    let mut positions: Vec<[f32; 3]> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut normals: Vec<[f32; 3]> = Vec::new();
    let mut cursor = 0usize;
    for &count in counts.iter() {
        let count = count.max(0) as usize;
        let curve = points.get(cursor..cursor + count).unwrap_or(&[]);
        cursor += count;
        // A segment contributes only when both endpoints are finite and
        // distinct; a curve with fewer than two usable points contributes
        // nothing (degenerate-face discipline), and the prim never fails.
        let usable_segments: Vec<usize> = (0..curve.len().saturating_sub(1))
            .filter(|&i| {
                let (a, b) = (curve[i], curve[i + 1]);
                let delta = [b.x - a.x, b.y - a.y, b.z - a.z];
                is_finite_vec3(a)
                    && is_finite_vec3(b)
                    && delta.iter().map(|d| d * d).sum::<f32>() > 0.0
            })
            .collect();
        let Some(&first) = usable_segments.first() else {
            continue;
        };

        // Seed a reference frame from the first tangent, then parallel
        // transport it onto each segment's own tangent.
        let tangent = normalize3([
            curve[first + 1].x - curve[first].x,
            curve[first + 1].y - curve[first].y,
            curve[first + 1].z - curve[first].z,
        ]);
        let helper: [f32; 3] = if tangent[1].abs() > 0.9 {
            [1.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        let mut u = normalize3(cross3(tangent, helper));

        for i in usable_segments {
            let (a, b) = (curve[i], curve[i + 1]);
            let tangent = normalize3([b.x - a.x, b.y - a.y, b.z - a.z]);
            let projection = u[0] * tangent[0] + u[1] * tangent[1] + u[2] * tangent[2];
            let transported = [
                u[0] - tangent[0] * projection,
                u[1] - tangent[1] * projection,
                u[2] - tangent[2] * projection,
            ];
            u = if transported.iter().map(|value| value * value).sum::<f32>() > 1e-12 {
                normalize3(transported)
            } else {
                let helper: [f32; 3] = if tangent[1].abs() > 0.9 {
                    [1.0, 0.0, 0.0]
                } else {
                    [0.0, 1.0, 0.0]
                };
                normalize3(cross3(tangent, helper))
            };
            let v = cross3(tangent, u);
            let base = positions.len() as u32;
            for center in [a, b] {
                for k in 0..CURVE_SIDES {
                    let theta = k as f32 * std::f32::consts::TAU / CURVE_SIDES as f32;
                    let (sin, cos) = (theta.sin(), theta.cos());
                    let radial = [
                        u[0] * cos + v[0] * sin,
                        u[1] * cos + v[1] * sin,
                        u[2] * cos + v[2] * sin,
                    ];
                    positions.push([
                        center.x + radius * radial[0],
                        center.y + radius * radial[1],
                        center.z + radius * radial[2],
                    ]);
                    // The normal is radial from the tube center axis per
                    // ring vertex (the tube shape makes this exact).
                    normals.push(radial);
                }
            }
            // Ring A first (offsets base..base+6), ring B second; each quad
            // fans to two outward-facing triangles.
            for k in 0..CURVE_SIDES {
                let next = ((k + 1) % CURVE_SIDES) as u32;
                let sides = CURVE_SIDES as u32;
                let (a_k, a_next) = (base + k as u32, base + next);
                let (b_k, b_next) = (base + sides + k as u32, base + sides + next);
                indices.extend_from_slice(&[a_k, a_next, b_next, a_k, b_next, b_k]);
            }
        }
    }

    let normals = if positions.is_empty() {
        None
    } else {
        Some(normals)
    };
    // shortcut: curve primvars (uvs, displayColor) do not scatter onto tube
    // rings yet — the bound material color applies; revisit when curves
    // need per-vertex colors.
    Ok(Some(MeshData {
        positions,
        normals,
        uvs: None,
        colors: None,
        indices,
    }))
}

fn points_data(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<MeshData>, String> {
    let points_schema = Points::from_prim_unchecked(prim.clone());
    let points: Vec<Vec3f> = expect_value(points_schema.points_at(time_code), "points", path)?;

    let (positions, orig_to_new) = compact_points(&points);
    let vertex_count = points.len();

    // No faces, so no indices and no face walk: vertex and constant
    // primvars reuse the mesh scatter through the (empty) corners list,
    // while uniform/faceVarying values answer None from it.
    let corners: Vec<(u32, usize, usize)> = Vec::new();
    let uvs = read_primvar::<Vec2f>(prim, "primvars:st", time_code, path)?
        .and_then(|(scope, values)| meshable(scope, values, &corners, vertex_count, &orig_to_new))
        .map(|per_vertex| per_vertex.into_iter().map(|v| [v.x, v.y]).collect());
    let colors = read_primvar::<Vec3f>(prim, "primvars:displayColor", time_code, path)?
        .and_then(|(scope, values)| meshable(scope, values, &corners, vertex_count, &orig_to_new))
        .map(|per_vertex| per_vertex.into_iter().map(|v| [v.x, v.y, v.z]).collect());

    // shortcut: the renderer's THREE.Points material ignores normals, so
    // authored points norms are dropped until it asks for them.
    Ok(Some(MeshData {
        positions,
        normals: None,
        uvs,
        colors,
        indices: Vec::new(),
    }))
}

fn is_finite_vec3(value: Vec3f) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

/// Non-finite positions cannot reach a GPU buffer: such vertices compact
/// away and survivors remap (the mapping is the original-vertex -> slot
/// list the primvar scatter consumes).
fn compact_points(points: &[Vec3f]) -> (Vec<[f32; 3]>, Vec<Option<u32>>) {
    let mut positions = Vec::with_capacity(points.len());
    let mut orig_to_new = Vec::with_capacity(points.len());
    for point in points.iter() {
        if is_finite_vec3(*point) {
            orig_to_new.push(Some(positions.len() as u32));
            positions.push([point.x, point.y, point.z]);
        } else {
            orig_to_new.push(None);
        }
    }
    (positions, orig_to_new)
}

fn cross3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn normalize3(value: [f32; 3]) -> [f32; 3] {
    let length = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
    if length > 0.0 {
        [value[0] / length, value[1] / length, value[2] / length]
    } else {
        [0.0, 0.0, 0.0]
    }
}

/// Binary wire layout of one mesh (Phase 2, Task 2), little-endian:
/// magic u32 = 0x55534442 ("USDB"), version u32 = 1, vertex_count u32,
/// index_count u32, flags u32 (bit0 has_normals, bit1 has_uvs, bit2
/// has_colors); then positions f32x3, normals f32x3, uvs f32x2, colors
/// f32x3 in flag-bit order, then indices u32. Per-vertex arrays must be
/// `positions.len()` long (tessellate_prim guarantees this).
pub fn pack_geometry(mesh: &MeshData) -> Vec<u8> {
    const MAGIC: u32 = 0x5553_4442;
    const VERSION: u32 = 1;
    let flags = mesh.normals.is_some() as u32
        | (mesh.uvs.is_some() as u32) << 1
        | (mesh.colors.is_some() as u32) << 2;
    let mut bytes = Vec::with_capacity(
        20 + mesh.positions.len() * 12
            + mesh.normals.as_ref().map_or(0, |v| v.len() * 12)
            + mesh.uvs.as_ref().map_or(0, |v| v.len() * 8)
            + mesh.colors.as_ref().map_or(0, |v| v.len() * 12)
            + mesh.indices.len() * 4,
    );
    for word in [
        MAGIC,
        VERSION,
        mesh.positions.len() as u32,
        mesh.indices.len() as u32,
        flags,
    ] {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    // Sections in flag-bit order: positions, normals, uvs, colors.
    push_vec3s(&mut bytes, &mesh.positions);
    if let Some(normals) = &mesh.normals {
        push_vec3s(&mut bytes, normals);
    }
    if let Some(uvs) = &mesh.uvs {
        push_vec2s(&mut bytes, uvs);
    }
    if let Some(colors) = &mesh.colors {
        push_vec3s(&mut bytes, colors);
    }
    for index in &mesh.indices {
        bytes.extend_from_slice(&index.to_le_bytes());
    }
    bytes
}

fn push_vec3s(bytes: &mut Vec<u8>, vectors: &[[f32; 3]]) {
    for vector in vectors {
        for component in vector {
            bytes.extend_from_slice(&component.to_le_bytes());
        }
    }
}

fn push_vec2s(bytes: &mut Vec<u8>, vectors: &[[f32; 2]]) {
    for vector in vectors {
        for component in vector {
            bytes.extend_from_slice(&component.to_le_bytes());
        }
    }
}

fn expect_value<T>(
    value: openusd::Result<Option<T>>,
    attribute: &str,
    path: &str,
) -> Result<T, String> {
    value
        .map_err(|e| context(path, e))?
        .ok_or_else(|| format!("failed to tessellate {}: no authored {}", path, attribute))
}

/// The `normals` attribute is not in the `primvars:` namespace: read its
/// values directly, with its interpolation as plain metadata.
fn normals_attr_values(
    mesh: &Mesh,
    time_code: Option<TimeCode>,
) -> Result<Option<(Scope, Vec<Vec3f>)>, SchemaError> {
    let attribute = mesh.normals_attr();
    let Some(values) = attribute.get_at::<Vec<Vec3f>>(time_code)? else {
        return Ok(None);
    };
    let scope = Scope::from_token(
        attribute
            .interpolation()?
            .as_ref()
            .map(|token| token.as_str()),
    );
    Ok(Some((scope, values)))
}

/// Authored `primvars:*` value at `time`, with its `<name>:indices` already
/// applied (`compute_flattened`), paired with the interpolation the values
/// must be scattered with.
fn read_primvar<U>(
    prim: &Prim,
    name: &str,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<(Scope, Vec<U>)>, String>
where
    Vec<U>: sdf::FromValue + std::convert::TryFrom<sdf::Value>,
    <Vec<U> as std::convert::TryFrom<sdf::Value>>::Error: Into<openusd::Error>,
{
    let Some(variable) = Primvar::from_attribute(prim.attribute(name)) else {
        return Ok(None);
    };
    let scope = Scope::from(variable.interpolation().map_err(|e| context(path, e))?);
    let values = variable
        .compute_flattened::<Vec<U>>(time_code)
        .map_err(|e| context(path, e))?;
    Ok(values.map(|values| (scope, values)))
}

/// Attribute values scattered to one entry per ORIGINAL vertex id
/// (`points.len()` long), or `None` when a demanded slot has no value —
/// the caller then drops the whole primvar instead of guessing.
fn attribution<T: Clone>(
    scope: Scope,
    values: Vec<T>,
    corners: &[(u32, usize, usize)],
    vertex_count: usize,
) -> Option<Vec<Option<T>>> {
    if values.is_empty() {
        return None;
    }
    match scope {
        Scope::Constant => Some(vec![Some(values.into_iter().next()?); vertex_count]),
        Scope::Vertex => Some(
            (0..vertex_count)
                .map(|id| values.get(id).cloned())
                .collect(),
        ),
        // Uniform values are one per face: scatter each face's value to that
        // face's surviving vertices (shared vertices keep the first face's
        // value, the same first-occurrence rule as faceVarying below).
        Scope::Uniform => {
            let mut out: Vec<Option<T>> = vec![None; vertex_count];
            for (vertex, _corner, face) in corners {
                let slot = values.get(*face).cloned();
                if let Some(entry) = out.get_mut(*vertex as usize) {
                    *entry = entry.take().or(slot);
                }
            }
            Some(out)
        }
        Scope::FaceVarying => {
            let mut out: Vec<Option<T>> = vec![None; vertex_count];
            for (vertex, corner, _face) in corners {
                let slot = values.get(*corner).cloned();
                if let Some(entry) = out.get_mut(*vertex as usize) {
                    *entry = entry.take().or(slot);
                }
            }
            Some(out)
        }
    }
}

/// Attribute values landed in primvar order, compacted into per-vertex
/// arrays that align with `positions`.
fn meshable<T: Clone>(
    scope: Scope,
    values: Vec<T>,
    corners: &[(u32, usize, usize)],
    vertex_count: usize,
    orig_to_new: &[Option<u32>],
) -> Option<Vec<T>> {
    let per_vertex = attribution(scope, values, corners, vertex_count)?;
    let mut out = Vec::new();
    for (orig, slot) in orig_to_new.iter().enumerate() {
        if slot.is_none() {
            continue;
        }
        out.push(per_vertex.get(orig)?.clone()?);
    }
    Some(out)
}

/// Per-vertex area-weighted average of face normals (the cross product is
/// accumulated unnormalized); vertices with no valid face normal keep a zero
/// normal.
fn generated_normals(positions: &[[f32; 3]], indices: &[u32]) -> Vec<[f32; 3]> {
    let mut accumulators = vec![[0.0f32; 3]; positions.len()];
    for triangle in indices.chunks_exact(3) {
        let [a, b, c] = [
            triangle[0] as usize,
            triangle[1] as usize,
            triangle[2] as usize,
        ];
        let (a, b, c) = (positions[a], positions[b], positions[c]);
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let normal = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        for &vertex in triangle {
            for axis in 0..3 {
                accumulators[vertex as usize][axis] += normal[axis];
            }
        }
    }
    accumulators
        .into_iter()
        .map(|accumulator| {
            let length = (accumulator[0] * accumulator[0]
                + accumulator[1] * accumulator[1]
                + accumulator[2] * accumulator[2])
                .sqrt();
            if length > 0.0 {
                [
                    accumulator[0] / length,
                    accumulator[1] / length,
                    accumulator[2] / length,
                ]
            } else {
                [0.0, 0.0, 0.0]
            }
        })
        .collect()
}
