//! Static-mesh tessellation (Phase 2, Task 1): one composed `Mesh` prim ->
//! render-ready triangle soup. A pure function over the openusd `Prim` — no
//! Tauri types; in the app this runs inside the stage-owner thread (Task 2
//! will bridge it).
//!
//! Triangulation fans each face `(v0, vi, vi+1)` over `faceVertexIndices`
//! and `faceVertexCounts`; holes and bridging are out of scope. Subdivision
//! meshes render their base hull. Authored `normals`, `primvars:st` and
//! `primvars:displayColor` are read at the queried time code; unauthored
//! normals are generated as per-vertex area-weighted face-normal averages.

use openusd::gf::{Vec2f, Vec3f};
use openusd::sdf;
use openusd::usd::{Prim, SchemaBase, TimeCode};
use openusd_schemas::geom::{AttributeMetadata, Interpolation, Mesh, Primvar};
use openusd_schemas::geom::{MeshSchema, PointBasedSchema};
use openusd_schemas::SchemaError;

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

/// Tessellate one composed prim. `Ok(None)` for anything that is not a
/// `Mesh`; `Err` names the prim path when the mesh itself cannot be
/// tessellated. `time: Some(t)` reads time-sampled attributes at `t`;
/// `None` reads the default-time values.
pub fn tessellate_prim(prim: &Prim, time: Option<f64>) -> Result<Option<MeshData>, String> {
    let path = prim.path().to_string();
    let is_mesh = prim
        .type_name()
        .map_err(|e| context(&path, e))?
        .is_some_and(|t| t.as_str() == "Mesh");
    // Typed `Mesh::from_prim` answers through the stage schema registry,
    // which our stage owner does not register — compare the straight type
    // name and view the prim unchecked instead.
    if !is_mesh {
        return Ok(None);
    }
    let mesh = Mesh::from_prim_unchecked(prim.clone());
    let time_code = time.map(TimeCode::new);

    let points: Vec<Vec3f> = expect_value(mesh.points_at(time_code), "points", &path)?;
    let counts: Vec<i32> = expect_value(
        mesh.face_vertex_counts_at(time_code),
        "faceVertexCounts",
        &path,
    )?;
    let index_list: Vec<i32> = expect_value(
        mesh.face_vertex_indices_at(time_code),
        "faceVertexIndices",
        &path,
    )?;

    let vertex_count = points.len();
    // Non-finite positions cannot reach a GPU buffer: such vertices are
    // compacted away, surviving indices remap, and any face referencing a
    // dropped (or out-of-range) vertex contributes nothing at all. Zero
    // lengths and coincident vertices are NOT non-finite, so faces that use
    // them stay.
    let mut positions: Vec<[f32; 3]> = Vec::with_capacity(points.len());
    let mut orig_to_new: Vec<Option<u32>> = Vec::with_capacity(points.len());
    for point in points.iter() {
        let keep = point.x.is_finite() && point.y.is_finite() && point.z.is_finite();
        if keep {
            orig_to_new.push(Some(positions.len() as u32));
            positions.push([point.x, point.y, point.z]);
        } else {
            orig_to_new.push(None);
        }
    }

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
            for v in [face[0], face[i], face[i + 1]] {
                indices.push(orig_to_new[v as usize].expect("face usability checked"));
            }
        }
    }

    // Authored normals first; nothing authored means generated ones (the
    // API cooperates, so generation landed in Task 1 instead of Task 5).
    // shortcut: an authored normal set that cannot map over the triangle
    // soup is dropped (normals: None) rather than falling back to generated
    // ones; revisit when the renderer cares about either lossy set.
    let normals = match normals_attr_values(&mesh, time_code).map_err(|e| context(&path, e))? {
        Some((scope, values)) => meshable(scope, values, &corners, vertex_count, &orig_to_new)
            .map(|per_vertex| per_vertex.into_iter().map(|v| [v.x, v.y, v.z]).collect()),
        None => Some(generated_normals(&positions, &indices)),
    };

    let uvs = read_primvar::<Vec2f>(&mesh, "primvars:st", time_code, &path)?
        .and_then(|(scope, values)| meshable(scope, values, &corners, vertex_count, &orig_to_new))
        .map(|per_vertex| per_vertex.into_iter().map(|v| [v.x, v.y]).collect());
    let colors = read_primvar::<Vec3f>(&mesh, "primvars:displayColor", time_code, &path)?
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
    mesh: &Mesh,
    name: &str,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<(Scope, Vec<U>)>, String>
where
    Vec<U>: sdf::FromValue + std::convert::TryFrom<sdf::Value>,
    <Vec<U> as std::convert::TryFrom<sdf::Value>>::Error: Into<openusd::Error>,
{
    let Some(variable) = Primvar::from_attribute(mesh.prim().attribute(name)) else {
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
