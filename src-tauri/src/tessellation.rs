//! Tessellation (Phase 2, Tasks 1/5): one composed geometry prim ->
//! render-ready data. A pure function over the openusd `Prim` — no
//! Tauri types; in the app this runs inside the stage-owner thread.
//!
//! `Mesh` prims triangulate by fanning each face `(v0, vi, vi+1)` over
//! `faceVertexIndices` and `faceVertexCounts` (holes and bridging are out
//! of scope; subdivision meshes render their base hull). `BasisCurves` and
//! `NurbsCurves` prims tessellate to open 6-sided tubes (no end caps) with
//! constant widths; a NURBS curve is sampled with de Boor first so the tube
//! follows its curvature, while a BasisCurve keeps its control polygon;
//! `Points` prims tessellate to a point cloud (indices empty); `Sphere` prims
//! tessellate analytically at a fixed 24×12 density, `Cube` prims to six
//! flat quads with per-face UVs, `Plane` prims to a single quad on the
//! axes their `axis` names, `Cylinder` and `Cylinder_1` prims to a revolved
//! surface with closed caps, `Cone` prims to a revolved cone on a closed base,
//! and `Capsule` and `Capsule_1` prims to a cylinder section capped by two half
//! spheres.
//! Authored `normals`, `primvars:st` and `primvars:displayColor` are read
//! at the queried time code; for meshes unauthored normals are generated
//! as per-vertex area-weighted face-normal averages.

use openusd::gf::{Vec2f, Vec3f};
use openusd::sdf;
use openusd::usd::{Prim, SchemaBase, TimeCode};
use openusd_schemas::geom::{
    AttributeMetadata, Axis, Capsule, CapsuleSchema, Capsule_1, Capsule_1Schema, Cone, ConeSchema,
    Cube, CubeSchema, Curves, CurvesSchema, Cylinder, CylinderSchema, Cylinder_1, Cylinder_1Schema,
    Interpolation, Mesh, NurbsCurves, NurbsCurvesSchema, Plane, PlaneSchema, Points, Primvar,
};
use openusd_schemas::geom::{MeshSchema, PointBasedSchema};
use openusd_schemas::SchemaError;

use crate::skinning;

/// One tessellated mesh: positions keyed per vertex, `indices` spanning
/// triangles by vertex index, and per-vertex primvar arrays aligned with
/// `positions` (constant replicates per vertex; vertex values follow the
/// original vertex, replicated across its split copies; faceVarying values
/// split an original vertex into one output vertex per distinct corner
/// value so UV seams keep their authored regions; uniform takes each
/// output vertex's first corner's face value).
#[derive(Debug, Clone, PartialEq)]
pub struct MeshData {
    pub positions: Vec<[f32; 3]>,
    pub normals: Option<Vec<[f32; 3]>>,
    pub uvs: Option<Vec<[f32; 2]>>,
    pub colors: Option<Vec<[f32; 3]>>,
    pub indices: Vec<u32>,
}

impl MeshData {
    /// Heap bytes this mesh holds, for the stage owner's cache budget.
    /// `Vec` capacity is what the allocator actually keeps, so it is what
    /// gets charged; the struct header itself is dwarfed by the buffers.
    pub fn size_bytes(&self) -> usize {
        let vertices = self.positions.capacity() * std::mem::size_of::<[f32; 3]>()
            + self.normals.as_ref().map_or(0, |values| {
                values.capacity() * std::mem::size_of::<[f32; 3]>()
            })
            + self.uvs.as_ref().map_or(0, |values| {
                values.capacity() * std::mem::size_of::<[f32; 2]>()
            })
            + self.colors.as_ref().map_or(0, |values| {
                values.capacity() * std::mem::size_of::<[f32; 3]>()
            });
        vertices + self.indices.capacity() * std::mem::size_of::<u32>()
    }
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
/// renderable geometry (Mesh, BasisCurves, NurbsCurves, Points, Sphere, Cube,
/// Plane, Cylinder, Cylinder_1, Cone, Capsule, Capsule_1);
/// `Err` names the prim path when the geometry itself cannot be tessellated.
/// `time: Some(t)`
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
        Some("BasisCurves") => curves_data(prim, time_code, &path, false),
        Some("NurbsCurves") => curves_data(prim, time_code, &path, true),
        Some("Points") => points_data(prim, time_code, &path),
        Some("Sphere") => sphere_data(prim, time_code, &path),
        Some("Cube") => cube_data(prim, time_code, &path),
        Some("Plane") => plane_data(prim, time_code, &path),
        Some("Cylinder") => cylinder_data(prim, time_code, &path),
        Some("Cylinder_1") => cylinder_data(prim, time_code, &path),
        Some("Cone") => cone_data(prim, time_code, &path),
        Some("Capsule") => capsule_data(prim, time_code, &path),
        Some("Capsule_1") => capsule_data(prim, time_code, &path),
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
    let (base_positions, orig_to_new) = compact_points(&points);
    let vertex_count = points.len();

    // Primvars are read before the split below: faceVarying values decide
    // which corners of one original vertex disagree (atlas UV seams) and
    // therefore how many output vertices it becomes.
    let uvs_raw = read_primvar::<Vec2f>(mesh.prim(), "primvars:st", time_code, path)?;
    let colors_raw = read_primvar::<Vec3f>(mesh.prim(), "primvars:displayColor", time_code, path)?;

    // Face walk: (surviving original vertex, flat corner slot, authored face
    // id) triples feed the primvar scatter; the corner slot aligns with
    // flattened faceVarying arrays and the face id with uniform arrays,
    // regardless of drops.
    let mut corners: Vec<(u32, usize, usize)> = Vec::new();
    let mut face_ranges: Vec<(usize, usize)> = Vec::new();
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
        let start = corners.len();
        for (slot, &v) in face.iter().enumerate() {
            corners.push((v as u32, cursor - count + slot, face_id));
        }
        face_ranges.push((start, count));
    }

    let (positions, scatter, corner_new) = split_face_varying(
        &authored_normals,
        &uvs_raw,
        &colors_raw,
        &corners,
        &base_positions,
        &orig_to_new,
    );

    // Triangulation: fan each usable face over its corners' split output
    // vertices; finite but zero-area fan triangles are filtered.
    let mut indices: Vec<u32> = Vec::new();
    for &(start, count) in &face_ranges {
        let face = &corner_new[start..start + count];
        for i in 1..count - 1 {
            let triangle = [face[0], face[i], face[i + 1]];
            let (a, b, c) = (
                positions[triangle[0] as usize],
                positions[triangle[1] as usize],
                positions[triangle[2] as usize],
            );
            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let area = cross3(ab, ac);
            if area.iter().map(|value| value * value).sum::<f32>() > 0.0 {
                indices.extend(triangle);
            }
        }
    }

    // Authored normals first; nothing authored means generated ones (the
    // API cooperates, so generation landed in Task 1 instead of Task 5).
    // shortcut: an authored normal set that cannot map over the triangle
    // soup is dropped (normals: None) rather than falling back to generated
    // ones; revisit when the renderer cares about either lossy set.
    let normals = match authored_normals {
        Some((scope, values)) => scatter
            .map(scope, values, &corners)
            .map(|per_vertex| per_vertex.into_iter().map(|v| [v.x, v.y, v.z]).collect()),
        None => Some(generated_normals(
            &positions,
            &indices,
            &scatter.orig_copies,
        )),
    };

    let uvs = uvs_raw
        .and_then(|(scope, values)| scatter.map(scope, values, &corners))
        .map(|per_vertex| per_vertex.into_iter().map(|v| [v.x, v.y]).collect());
    let colors = colors_raw
        .and_then(|(scope, values)| scatter.map(scope, values, &corners))
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

    let colors = display_colors(prim, time_code, path, positions.len())?;
    Ok(Some(MeshData {
        positions,
        normals: Some(normals),
        uvs: Some(uvs),
        colors,
        indices,
    }))
}

/// Six quads of four vertices each, centred on the origin: flat outward
/// normals, per-face 0..1 UVs, counter-clockwise seen from outside.
fn cube_data(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<MeshData>, String> {
    let cube = Cube::from_prim_unchecked(prim.clone());
    let half = finite_positive(cube.size_at(time_code).map_err(|e| context(path, e))?, 2.0) / 2.0;

    let mut positions = Vec::with_capacity(24);
    let mut normals = Vec::with_capacity(24);
    let mut uvs = Vec::with_capacity(24);
    let mut indices = Vec::with_capacity(36);
    // One quad per axis and sign; the tangent pair is wound so that
    // `u x v` points along the face's own outward normal.
    for axis in 0..3 {
        let (u_axis, v_axis) = ((axis + 1) % 3, (axis + 2) % 3);
        for sign in [1.0f32, -1.0] {
            let mut normal = [0.0f32; 3];
            normal[axis] = sign;
            let offset = half * sign;
            let base = positions.len() as u32;
            for (du, dv) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
                let mut position = [0.0f32; 3];
                position[axis] = offset;
                position[u_axis] = half * du;
                position[v_axis] = half * dv * sign;
                positions.push(position);
                normals.push(normal);
            }
            uvs.extend_from_slice(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
            indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
    }

    let colors = display_colors(prim, time_code, path, positions.len())?;
    Ok(Some(MeshData {
        positions,
        normals: Some(normals),
        uvs: Some(uvs),
        colors,
        indices,
    }))
}

/// One quad of four vertices centred on the origin. The schema's `axis`
/// names the normal, and `width` and `length` span the two axes left over;
/// the winding and the length sign are picked so the normal points along
/// the positive axis.
fn plane_data(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<MeshData>, String> {
    let plane = Plane::from_prim_unchecked(prim.clone());
    let half_width = finite_positive(
        plane.width_at(time_code).map_err(|e| context(path, e))?,
        2.0,
    ) / 2.0;
    let half_length = finite_positive(
        plane.length_at(time_code).map_err(|e| context(path, e))?,
        2.0,
    ) / 2.0;
    // `axis` is uniform, so it takes no time code.
    let axis = plane
        .axis()
        .map_err(|e| context(path, e))?
        .and_then(|token| Axis::from_token(token.as_str()))
        .unwrap_or(Axis::Z);
    let (width_axis, length_axis, normal_axis, length_sign) = match axis {
        // Z is the base case: its winding already runs counter-clockwise.
        Axis::Z => (0, 1, 2, 1.0f32),
        Axis::Y => (0, 2, 1, -1.0f32),
        Axis::X => (2, 1, 0, -1.0f32),
    };

    let mut normal = [0.0f32; 3];
    normal[normal_axis] = 1.0;
    let mut positions = Vec::with_capacity(4);
    for (du, dv) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
        let mut position = [0.0f32; 3];
        position[width_axis] = half_width * du;
        position[length_axis] = half_length * dv * length_sign;
        positions.push(position);
    }

    let colors = display_colors(prim, time_code, path, positions.len())?;
    Ok(Some(MeshData {
        positions,
        normals: Some(vec![normal; 4]),
        uvs: Some(vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]),
        colors,
        indices: vec![0, 1, 2, 0, 2, 3],
    }))
}

/// Ring vertices per profile point of a revolved surface; the extra vertex
/// closes the UV seam.
const SEGMENTS: usize = 24;

/// Map the canonical +Z build axis onto the axis the prim names.
fn axis_swap(axis: Axis, value: [f32; 3]) -> [f32; 3] {
    match axis {
        Axis::Z => value,
        Axis::X => [value[2], value[1], value[0]],
        Axis::Y => [value[0], value[2], value[1]],
    }
}

/// A surface of revolution around +Z, then swapped onto `axis`. `profile` is
/// `(off_axis_radius, on_axis)`, bottom to top; a zero radius is an on-axis
/// point and emits one vertex instead of a ring.
fn revolved(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
    profile: &[(f32, f32)],
    axis: Axis,
) -> Result<MeshData, String> {
    let mut positions: Vec<[f32; 3]> = Vec::with_capacity(profile.len() * (SEGMENTS + 1));
    let mut normals: Vec<[f32; 3]> = Vec::with_capacity(positions.capacity());
    let mut uvs: Vec<[f32; 2]> = Vec::with_capacity(positions.capacity());
    // First vertex index of each profile row and how many vertices it holds.
    let mut rows: Vec<(usize, usize)> = Vec::with_capacity(profile.len());
    for (index, &(radius, on_axis)) in profile.iter().enumerate() {
        // Central difference inside the profile, one-sided at the ends: a
        // duplicated point keeps two distinct normal rows, so its rim stays
        // hard instead of averaged.
        let previous = profile[index.saturating_sub(1)];
        let next = profile[(index + 1).min(profile.len() - 1)];
        let tangent = normalize3([next.0 - previous.0, next.1 - previous.1, 0.0]);
        let (normal_off, normal_on) = (tangent[1], -tangent[0]);
        let v = index as f32 / (profile.len() - 1).max(1) as f32;
        let start = positions.len();
        if radius == 0.0 {
            positions.push(axis_swap(axis, [0.0, 0.0, on_axis]));
            normals.push(axis_swap(axis, [0.0, 0.0, normal_on]));
            uvs.push([0.5, v]);
        } else {
            for u in 0..=SEGMENTS {
                let theta = std::f32::consts::TAU * u as f32 / SEGMENTS as f32;
                let (sin, cos) = theta.sin_cos();
                positions.push(axis_swap(axis, [radius * cos, radius * sin, on_axis]));
                normals.push(axis_swap(
                    axis,
                    [normal_off * cos, normal_off * sin, normal_on],
                ));
                uvs.push([u as f32 / SEGMENTS as f32, v]);
            }
        }
        rows.push((start, positions.len() - start));
    }

    // Consecutive rows sweep one band; a one-vertex row (on-axis point) turns
    // its band into a triangle fan. Wound counter-clockwise seen from outside.
    let mut indices: Vec<u32> = Vec::new();
    for pair in rows.windows(2) {
        let (a, a_count) = pair[0];
        let (b, b_count) = pair[1];
        for u in 0..SEGMENTS {
            let (a_u, b_u) = ((a + u) as u32, (b + u) as u32);
            match (a_count, b_count) {
                (1, 1) => break,
                (1, _) => indices.extend_from_slice(&[a as u32, b_u + 1, b_u]),
                (_, 1) => indices.extend_from_slice(&[a_u, a_u + 1, b as u32]),
                _ => indices.extend_from_slice(&[a_u, a_u + 1, b_u, a_u + 1, b_u + 1, b_u]),
            }
        }
    }

    // `axis_swap` mirrors for X and Y, which reverses the winding those
    // triangles inherit from the canonical build: swap two corners to keep
    // them counter-clockwise seen from outside.
    if !matches!(axis, Axis::Z) {
        for triangle in indices.chunks_exact_mut(3) {
            triangle.swap(1, 2);
        }
    }

    let colors = display_colors(prim, time_code, path, positions.len())?;
    Ok(MeshData {
        positions,
        normals: Some(normals),
        uvs: Some(uvs),
        colors,
        indices,
    })
}

/// A cylinder about the origin: radius 1 and height 2 by default, its `axis`
/// naming the height's direction. The profile's on-axis endpoints are the cap
/// centres, so both caps come out as fans with the axis normal. `Cylinder_1`
/// authors the two rim radii separately instead of one `radius`.
fn cylinder_data(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<MeshData>, String> {
    let cylinder = Cylinder::from_prim_unchecked(prim.clone());
    // A zero height is a legal flat disc, so it keeps its authored value and
    // floors below, instead of taking finite_positive's positive-only default.
    // A negative height has no meaning and falls back like an unauthored one.
    let height = cylinder
        .height_at(time_code)
        .map_err(|e| context(path, e))?
        .map(|height| height as f32)
        .filter(|height| height.is_finite() && *height >= 0.0)
        .unwrap_or(2.0)
        .max(1e-4);
    // A zero radius is legal too: `revolved()` collapses it to the axis.
    let (radius_bottom, radius_top) = if tapered(prim, "Cylinder_1", path)? {
        let cylinder = Cylinder_1::from_prim_unchecked(prim.clone());
        (
            finite_non_negative(
                cylinder
                    .radius_bottom_at(time_code)
                    .map_err(|e| context(path, e))?,
                1.0,
            ),
            finite_non_negative(
                cylinder
                    .radius_top_at(time_code)
                    .map_err(|e| context(path, e))?,
                1.0,
            ),
        )
    } else {
        let radius = finite_non_negative(
            cylinder
                .radius_at(time_code)
                .map_err(|e| context(path, e))?,
            1.0,
        );
        (radius, radius)
    };
    // `axis` is uniform, so it takes no time code.
    let axis = cylinder
        .axis()
        .map_err(|e| context(path, e))?
        .unwrap_or(Axis::Z);
    let half = height / 2.0;
    // Each rim point is duplicated: the duplicate gives the cap edge and the
    // side wall distinct normal rows, so the rim stays hard.
    let profile = [
        (0.0, -half),
        (radius_bottom, -half),
        (radius_bottom, -half),
        (radius_top, half),
        (radius_top, half),
        (0.0, half),
    ];
    Ok(Some(revolved(prim, time_code, path, &profile, axis)?))
}

/// A cone about the origin: `radius` at the bottom, an apex `height` up the
/// prim's `axis`. Defaults are radius 1 and height 2.
fn cone_data(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<MeshData>, String> {
    let cone = Cone::from_prim_unchecked(prim.clone());
    // Same height contract as the cylinder: an authored zero is a legal flat
    // disc and floors below, a negative or non-finite height falls back.
    let height = cone
        .height_at(time_code)
        .map_err(|e| context(path, e))?
        .map(|height| height as f32)
        .filter(|height| height.is_finite() && *height >= 0.0)
        .unwrap_or(2.0)
        .max(1e-4);
    let radius = finite_non_negative(
        cone.radius_at(time_code).map_err(|e| context(path, e))?,
        1.0,
    );
    // `axis` is uniform, so it takes no time code. `ConeSchema` hands back the
    // token, not the enum, unlike `CylinderSchema`.
    let axis = cone
        .axis()
        .map_err(|e| context(path, e))?
        .and_then(|token| Axis::from_token(token.as_str()))
        .unwrap_or(Axis::Z);
    let half = height / 2.0;
    // The base rim is duplicated for the cylinder's reason: it keeps the cap
    // on the axial normal and the wall on the slant normal. The apex is one
    // on-axis vertex, so it needs no duplicate.
    let profile = [(0.0, -half), (radius, -half), (radius, -half), (0.0, half)];
    Ok(Some(revolved(prim, time_code, path, &profile, axis)?))
}

/// Rows per hemisphere cap.
const CAP_ROWS: usize = 6;

/// A capsule about the origin: a `height`-long cylinder along `axis`, capped by
/// two half spheres of `radius`. Defaults are height 1 and radius 0.5, so the
/// total length on the axis is `height + 2 * radius`. `Capsule_1` sizes each cap
/// with its own radius, and the section between the caps tapers between them.
fn capsule_data(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
) -> Result<Option<MeshData>, String> {
    let capsule = Capsule::from_prim_unchecked(prim.clone());
    // Same height contract as the cylinder, with the capsule's own default.
    let height = capsule
        .height_at(time_code)
        .map_err(|e| context(path, e))?
        .map(|height| height as f32)
        .filter(|height| height.is_finite() && *height >= 0.0)
        .unwrap_or(1.0)
        .max(1e-4);
    let (radius_bottom, radius_top) = if tapered(prim, "Capsule_1", path)? {
        let capsule = Capsule_1::from_prim_unchecked(prim.clone());
        (
            finite_non_negative(
                capsule
                    .radius_bottom_at(time_code)
                    .map_err(|e| context(path, e))?,
                0.5,
            ),
            finite_non_negative(
                capsule
                    .radius_top_at(time_code)
                    .map_err(|e| context(path, e))?,
                0.5,
            ),
        )
    } else {
        let radius = finite_non_negative(
            capsule.radius_at(time_code).map_err(|e| context(path, e))?,
            0.5,
        );
        (radius, radius)
    };
    // `axis` is uniform, so it takes no time code. `CapsuleSchema` hands back
    // the token, not the enum, like `ConeSchema`.
    let axis = capsule
        .axis()
        .map_err(|e| context(path, e))?
        .and_then(|token| Axis::from_token(token.as_str()))
        .unwrap_or(Axis::Z);
    let half = height / 2.0;
    // A capsule has no hard edge: every row meets the next tangentially, so no
    // point is duplicated and the normals stay smooth across the hemisphere
    // joins. Each cap is measured from its pole, where the angle is exactly 0
    // and the row collapses to one on-axis vertex. The section between the two
    // equators tapers from one authored radius to the other, so nothing ever
    // divides by their difference.
    let mut profile: Vec<(f32, f32)> = Vec::with_capacity(2 * (CAP_ROWS + 1) + 1);
    for row in 0..=CAP_ROWS {
        let angle = std::f32::consts::FRAC_PI_2 * row as f32 / CAP_ROWS as f32;
        let (sin, cos) = angle.sin_cos();
        profile.push((radius_bottom * sin, -half - radius_bottom * cos));
    }
    profile.push((radius_top, half));
    for row in (0..CAP_ROWS).rev() {
        let angle = std::f32::consts::FRAC_PI_2 * row as f32 / CAP_ROWS as f32;
        let (sin, cos) = angle.sin_cos();
        profile.push((radius_top * sin, half + radius_top * cos));
    }
    Ok(Some(revolved(prim, time_code, path, &profile, axis)?))
}

/// Whether `prim` is the two-radius variant of a shape. Such a prim carries the
/// plain prim's `height` and `axis` names, so only the radii need the other
/// schema view.
fn tapered(prim: &Prim, type_name: &str, path: &str) -> Result<bool, String> {
    Ok(prim
        .type_name()
        .map_err(|e| context(path, e))?
        .map(|name| name.to_string())
        .as_deref()
        == Some(type_name))
}

/// An authored radius of exactly 0 has meaning — the profile collapses to the
/// axis — so unlike `finite_positive` it keeps that value; a non-finite or
/// negative radius falls back like an unauthored one.
fn finite_non_negative(value: Option<f64>, fallback: f32) -> f32 {
    value
        .map(|value| value as f32)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(fallback)
}

/// An authored size that is non-finite or non-positive has no meaning, so it
/// falls back like an unauthored one.
fn finite_positive(value: Option<f64>, fallback: f32) -> f32 {
    value
        .map(|value| value as f32)
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(fallback)
}

/// `primvars:displayColor` as one color per output vertex: a constant value
/// replicates, a vertex value passes through when it matches the vertex
/// count, and any other scope yields nothing.
fn display_colors(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
    vertex_count: usize,
) -> Result<Option<Vec<[f32; 3]>>, String> {
    Ok(
        read_primvar::<Vec3f>(prim, "primvars:displayColor", time_code, path)?.and_then(
            |(scope, values)| match scope {
                Scope::Constant => values
                    .first()
                    .map(|color| vec![[color.x, color.y, color.z]; vertex_count]),
                Scope::Vertex if values.len() == vertex_count => Some(
                    values
                        .into_iter()
                        .map(|color| [color.x, color.y, color.z])
                        .collect(),
                ),
                _ => None,
            },
        ),
    )
}

/// 6-sided tube cross-section (controller resolution).
const CURVE_SIDES: usize = 6;
/// Unauthored (or non-positive, non-finite) curve width fallback per the
/// brief: a constant width of 0.1 -> a 0.05 ring radius.
const DEFAULT_CURVE_WIDTH: f32 = 0.1;

/// One curves prim read: the polylines the tube builder consumes (a NURBS
/// curve's points are already evaluated) and its constant tube radius.
struct CurveData {
    curves: Vec<Vec<Vec3f>>,
    radius: f32,
}

fn curves_data(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
    is_nurbs: bool,
) -> Result<Option<MeshData>, String> {
    let CurveData { curves, radius } = curves_read(prim, time_code, path, is_nurbs)?;
    Ok(Some(curve_tubes(&curves, radius)))
}

/// Read stage: the points each curve tessellates, before any tube is built.
/// A NURBS prim is sampled with de Boor here; every failure path keeps the
/// authored control points so the prim still renders (fail-soft).
fn curves_read(
    prim: &Prim,
    time_code: Option<TimeCode>,
    path: &str,
    is_nurbs: bool,
) -> Result<CurveData, String> {
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

    let slices = split_curve_points(&points, &counts);
    let curves = if is_nurbs {
        evaluated_curves(prim, time_code, &slices, path)
            .unwrap_or_else(|| control_polygons(&slices))
    } else {
        control_polygons(&slices)
    };
    Ok(CurveData { curves, radius })
}

/// One slice of the flattened `points` array per curve, clamped to the array
/// like the tube builder always did (an overlong count yields a short curve).
fn split_curve_points<'a>(points: &'a [Vec3f], counts: &[i32]) -> Vec<&'a [Vec3f]> {
    let mut slices = Vec::with_capacity(counts.len());
    let mut cursor = 0usize;
    for &count in counts {
        let count = count.max(0) as usize;
        slices.push(points.get(cursor..cursor + count).unwrap_or(&[]));
        cursor += count;
    }
    slices
}

fn control_polygons(slices: &[&[Vec3f]]) -> Vec<Vec<Vec3f>> {
    slices.iter().map(|slice| slice.to_vec()).collect()
}

/// Samples per knot span, and the most evaluated points one curve may
/// contribute. shortcut: the chord error is bounded by the sample count
/// rather than measured against a tolerance; raise NURBS_SAMPLES_PER_SPAN
/// if a fixture needs a smoother arc.
const NURBS_SAMPLES_PER_SPAN: usize = 8;
const NURBS_SAMPLE_CAP: usize = 4096;

/// Read the prim's NURBS attributes and evaluate each curve. `None` means the
/// attributes could not be read at all, so every curve keeps its control
/// polygon; a curve whose own order/knots/weights disagree does the same
/// alone (Round 1 behaviour, never a failed prim).
fn evaluated_curves(
    prim: &Prim,
    time_code: Option<TimeCode>,
    slices: &[&[Vec3f]],
    path: &str,
) -> Option<Vec<Vec<Vec3f>>> {
    let nurbs = NurbsCurves::from_prim_unchecked(prim.clone());
    let order = logged(nurbs.order_at(time_code), path, "order")?;
    let knots = logged(nurbs.knots_at(time_code), path, "knots")?;
    // Unauthored (or unreadable) pointWeights mean a non-rational curve.
    let weights = nurbs.point_weights_at(time_code).unwrap_or(None);
    let ranges = nurbs.ranges_at(time_code).unwrap_or(None);
    // Per-curve weights are sliced out of the flat array, so a total count
    // that misses the point count would shift every slice onto the wrong
    // points: the prim keeps its control polygons instead.
    let total_points = slices.iter().map(|slice| slice.len()).sum::<usize>();
    if let Some(values) = weights.as_ref() {
        if !values.is_empty() && values.len() != total_points {
            eprintln!(
                "nurbs {}: {} pointWeights for {} points, using the control polygon",
                path,
                values.len(),
                total_points
            );
            return None;
        }
    }

    let mut curves = Vec::with_capacity(slices.len());
    let mut knot_cursor = 0usize;
    let mut point_cursor = 0usize;
    for (index, slice) in slices.iter().enumerate() {
        // A missing order entry must not desync the knot cursor the later
        // curves read through: default to the prim's largest order, so only
        // the curve without an order falls back.
        let order = order
            .get(index)
            .copied()
            .unwrap_or_else(|| order.iter().copied().max().unwrap_or(1));
        let knot_count = slice.len().saturating_add(order.max(0) as usize);
        let curve_knots = knots
            .get(knot_cursor..knot_cursor.saturating_add(knot_count))
            .unwrap_or(&[]);
        knot_cursor = knot_cursor.saturating_add(knot_count);
        let curve_weights = weights
            .as_ref()
            .and_then(|values| values.get(point_cursor..point_cursor.saturating_add(slice.len())))
            .unwrap_or(&[]);
        point_cursor = point_cursor.saturating_add(slice.len());
        let range = ranges
            .as_ref()
            .and_then(|values| values.get(index))
            .map(|range| (range.x, range.y));
        curves.push(
            evaluate_nurbs(slice, order, curve_knots, curve_weights, range).unwrap_or_else(|| {
                eprintln!(
                    "nurbs {}: curve {} has inconsistent order/knots/weights, \
                     using the control polygon",
                    path, index
                );
                slice.to_vec()
            }),
        );
    }
    Some(curves)
}

/// A required NURBS attribute, logged when it is missing or unreadable — the
/// caller then falls back to the control polygon instead of failing the prim.
fn logged<T>(value: openusd::Result<Option<T>>, path: &str, attribute: &str) -> Option<T> {
    match value {
        Ok(Some(value)) => Some(value),
        Ok(None) => {
            eprintln!(
                "nurbs {}: no authored {}, using the control polygon",
                path, attribute
            );
            None
        }
        Err(e) => {
            eprintln!(
                "nurbs {}: reading {} failed: {}, using the control polygon",
                path, attribute, e
            );
            None
        }
    }
}

/// de Boor evaluation of one (optionally rational) NURBS curve, sampled once
/// per knot span. `None` when the curve's order, knots or weights disagree
/// with its point count — the caller then keeps the control polygon.
fn evaluate_nurbs(
    points: &[Vec3f],
    order: i32,
    knots: &[f64],
    weights: &[f64],
    range: Option<(f64, f64)>,
) -> Option<Vec<Vec3f>> {
    let n = points.len();
    // Order is degree + 1, so order 1 (a piecewise constant) is not a curve.
    if order < 2 || !points.iter().all(|point| is_finite_vec3(*point)) {
        return None;
    }
    let degree = order as usize - 1;
    if n <= degree || knots.len() != n + degree + 1 {
        return None;
    }
    if knots.iter().any(|knot| !knot.is_finite()) {
        return None;
    }
    if knots.windows(2).any(|pair| pair[1] < pair[0]) {
        return None;
    }
    // Rational curves need positive finite weights: a non-positive one has
    // no projective meaning, so the control polygon is the safe answer.
    let rational = !weights.is_empty();
    if rational
        && (weights.len() != n
            || weights
                .iter()
                .any(|weight| !weight.is_finite() || *weight <= 0.0))
    {
        return None;
    }
    let weights = if rational {
        weights.to_vec()
    } else {
        vec![1.0; n]
    };

    let (lo, hi) = knot_domain(knots, degree, n, range)?;
    let spans = knot_spans(knots, degree, n, lo, hi);
    if spans.is_empty() {
        return None;
    }
    // The cap bounds the whole curve. Past it the per-span floor of one sample
    // would let the tube grow with the span count (a 100k-span curve ships
    // 600k ring vertices), so a curve this dense keeps its control polygon.
    if spans.len() > NURBS_SAMPLE_CAP {
        return None;
    }
    let per_span = ((NURBS_SAMPLE_CAP - 1) / spans.len()).clamp(1, NURBS_SAMPLES_PER_SPAN);
    let mut samples = Vec::with_capacity(spans.len() * per_span + 1);
    for &(start, end) in &spans {
        for step in 0..per_span {
            samples.push(start + (end - start) * step as f64 / per_span as f64);
        }
    }
    samples.push(hi);

    samples
        .into_iter()
        .map(|u| de_boor(knots, degree, n, points, &weights, u))
        .collect()
}

/// The parameter domain the curve is defined over: its knot bounds, narrowed
/// to the authored `ranges` entry when there is one.
fn knot_domain(
    knots: &[f64],
    degree: usize,
    n: usize,
    range: Option<(f64, f64)>,
) -> Option<(f64, f64)> {
    let start = *knots.get(degree)?;
    let end = *knots.get(n)?;
    let (lo, hi) = match range {
        Some((min, max)) => (start.max(min), end.min(max)),
        None => (start, end),
    };
    (lo < hi && hi.is_finite()).then_some((lo, hi))
}

/// The curve's non-empty knot spans, clipped to `[lo, hi]`.
fn knot_spans(knots: &[f64], degree: usize, n: usize, lo: f64, hi: f64) -> Vec<(f64, f64)> {
    let Some(valid) = knots.get(degree..=n) else {
        return Vec::new();
    };
    valid
        .windows(2)
        .filter_map(|pair| {
            let (start, end) = (pair[0].max(lo), pair[1].min(hi));
            (start < end).then_some((start, end))
        })
        .collect()
}

/// One de Boor step: the `degree + 1` control points in the span holding `u`,
/// combined in homogeneous coordinates so rational curves divide out their
/// weights at the end (weights of 1 make the division an exact identity).
fn de_boor(
    knots: &[f64],
    degree: usize,
    n: usize,
    points: &[Vec3f],
    weights: &[f64],
    u: f64,
) -> Option<Vec3f> {
    // The active span is the last one whose left knot does not pass `u`; at
    // the domain end that is the final span, where the standard algorithm
    // still resolves (its last interpolation is alpha = 1).
    let span = (degree..n)
        .rev()
        .find(|&k| knots[k] <= u && knots[k] < knots[k + 1])?;
    let mut spread: Vec<[f64; 4]> = (0..=degree)
        .map(|j| {
            let index = span + j - degree;
            let weight = weights[index];
            let point = points[index];
            [
                point.x as f64 * weight,
                point.y as f64 * weight,
                point.z as f64 * weight,
                weight,
            ]
        })
        .collect();
    for r in 1..=degree {
        for j in (r..=degree).rev() {
            let index = span + j - degree;
            let denominator = knots[index + degree + 1 - r] - knots[index];
            if denominator <= 0.0 {
                return None;
            }
            let alpha = (u - knots[index]) / denominator;
            let (previous, current) = (spread[j - 1], spread[j]);
            spread[j] = [
                previous[0] * (1.0 - alpha) + current[0] * alpha,
                previous[1] * (1.0 - alpha) + current[1] * alpha,
                previous[2] * (1.0 - alpha) + current[2] * alpha,
                previous[3] * (1.0 - alpha) + current[3] * alpha,
            ];
        }
    }
    let value = spread[degree];
    if value[3] == 0.0 {
        return None;
    }
    Some(Vec3f {
        x: (value[0] / value[3]) as f32,
        y: (value[1] / value[3]) as f32,
        z: (value[2] / value[3]) as f32,
    })
}

/// Tube stage: open 6-sided tubes (no end caps) through one polyline per
/// curve, with one ring per used point and minimum-rotation frames along
/// each curve.
fn curve_tubes(curves: &[Vec<Vec3f>], radius: f32) -> MeshData {
    let mut positions: Vec<[f32; 3]> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut normals: Vec<[f32; 3]> = Vec::new();
    for curve in curves.iter() {
        let curve = curve.as_slice();
        // A segment contributes only when both endpoints are finite and
        // distinct; a curve with fewer than two usable points contributes
        // nothing (degenerate-face discipline), and the prim never fails.
        let usable: Vec<bool> = (0..curve.len().saturating_sub(1))
            .map(|i| {
                let (a, b) = (curve[i], curve[i + 1]);
                let delta = [b.x - a.x, b.y - a.y, b.z - a.z];
                is_finite_vec3(a)
                    && is_finite_vec3(b)
                    && delta.iter().map(|d| d * d).sum::<f32>() > 0.0
            })
            .collect();
        // Runs of adjacent usable segments are separate tubes: an unusable
        // point breaks the chain instead of leaving a lone ring behind.
        let mut start = 0;
        while start < usable.len() {
            let Some(offset) = usable[start..].iter().position(|usable| *usable) else {
                break;
            };
            start += offset;
            let segments = usable[start..].iter().take_while(|usable| **usable).count();
            let end = start + segments;
            let (chain_positions, chain_normals, chain_indices) =
                tube_chain(&curve[start..=end], radius);
            let base = positions.len() as u32;
            positions.extend(chain_positions);
            normals.extend(chain_normals);
            indices.extend(chain_indices.into_iter().map(|index| index + base));
            start = end;
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
    MeshData {
        positions,
        normals,
        uvs: None,
        colors: None,
        indices,
    }
}

/// Miter cap: a near-reversal must not shoot a spike out of the joint.
const CURVE_MITER_MAX: f32 = 4.0;

/// One continuous tube through `points` (at least two finite, distinct
/// neighbours): a ring per point, consecutive rings welded by quads.
fn tube_chain(points: &[Vec3f], radius: f32) -> (Vec<[f32; 3]>, Vec<[f32; 3]>, Vec<u32>) {
    let count = points.len();
    let segment = |i: usize| {
        normalize3([
            points[i + 1].x - points[i].x,
            points[i + 1].y - points[i].y,
            points[i + 1].z - points[i].z,
        ])
    };
    // Ring planes: a segment's own direction at an end of the chain, the
    // bisector of the two adjacent segments inside it, with the miter scale
    // that makes both segments meet on that one plane.
    let mut frames: Vec<([f32; 3], f32)> = Vec::with_capacity(count);
    for i in 0..count {
        let (tangent, miter) = if i == 0 {
            (segment(0), 1.0)
        } else if i == count - 1 {
            (segment(count - 2), 1.0)
        } else {
            let (previous, next) = (segment(i - 1), segment(i));
            let bisector = [
                previous[0] + next[0],
                previous[1] + next[1],
                previous[2] + next[2],
            ];
            if bisector.iter().map(|value| value * value).sum::<f32>() > 1e-12 {
                (normalize3(bisector), miter_scale(previous, next))
            } else {
                // A 180-degree reversal has no bisector: keep one segment's
                // direction so the frame stays finite.
                (previous, CURVE_MITER_MAX)
            }
        };
        frames.push((tangent, miter));
    }

    let mut positions: Vec<[f32; 3]> = Vec::with_capacity(count * CURVE_SIDES);
    let mut normals: Vec<[f32; 3]> = Vec::with_capacity(count * CURVE_SIDES);
    let mut u = seed_frame(frames[0].0);
    for (i, (tangent, miter)) in frames.iter().enumerate() {
        if i > 0 {
            u = rotate_between(u, frames[i - 1].0, *tangent);
        }
        let v = cross3(*tangent, u);
        let center = points[i];
        let scale = radius * miter;
        for k in 0..CURVE_SIDES {
            let theta = k as f32 * std::f32::consts::TAU / CURVE_SIDES as f32;
            let (sin, cos) = (theta.sin(), theta.cos());
            let radial = [
                u[0] * cos + v[0] * sin,
                u[1] * cos + v[1] * sin,
                u[2] * cos + v[2] * sin,
            ];
            positions.push([
                center.x + scale * radial[0],
                center.y + scale * radial[1],
                center.z + scale * radial[2],
            ]);
            // The normal is radial from the tube center axis per ring vertex
            // (the tube shape makes this exact).
            normals.push(radial);
        }
    }

    // Ring i and ring i+1 share their vertices; each quad fans to two
    // outward-facing triangles.
    let mut indices: Vec<u32> = Vec::with_capacity((count - 1) * CURVE_SIDES * 6);
    for ring in 0..count - 1 {
        let sides = CURVE_SIDES as u32;
        let a = ring as u32 * sides;
        let b = a + sides;
        for k in 0..sides {
            let next = (k + 1) % sides;
            indices.extend_from_slice(&[a + k, a + next, b + next, a + k, b + next, b + k]);
        }
    }
    (positions, normals, indices)
}

/// Radius multiplier that moves a ring's vertices out to where the two
/// adjacent segment tubes cross the ring plane: `1 / cos(half the turn)`,
/// clamped so a near-reversal cannot spike.
fn miter_scale(previous: [f32; 3], next: [f32; 3]) -> f32 {
    let turn_cos = previous[0] * next[0] + previous[1] * next[1] + previous[2] * next[2];
    let half_cos = ((1.0 + turn_cos) * 0.5).max(0.0).sqrt();
    (1.0 / half_cos).clamp(1.0, CURVE_MITER_MAX)
}

/// Seed the ring frame perpendicular to `tangent` with the helper-vector rule.
fn seed_frame(tangent: [f32; 3]) -> [f32; 3] {
    let helper: [f32; 3] = if tangent[1].abs() > 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    normalize3(cross3(tangent, helper))
}

/// Transport `vector` by the minimum rotation that takes `from` onto `to`
/// (Rodrigues). Parallel and reversed tangents keep `vector` as it is: the
/// rotation axis is undefined there.
fn rotate_between(vector: [f32; 3], from: [f32; 3], to: [f32; 3]) -> [f32; 3] {
    let axis = cross3(from, to);
    let sin = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    if sin < 1e-6 {
        return vector;
    }
    let cos = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
    let axis = normalize3(axis);
    let kxv = cross3(axis, vector);
    let kdv = axis[0] * vector[0] + axis[1] * vector[1] + axis[2] * vector[2];
    [
        vector[0] * cos + kxv[0] * sin + axis[0] * kdv * (1.0 - cos),
        vector[1] * cos + kxv[1] * sin + axis[1] * kdv * (1.0 - cos),
        vector[2] * cos + kxv[2] * sin + axis[2] * kdv * (1.0 - cos),
    ]
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

    // No faces, so no corners and no splits: every surviving original
    // vertex is exactly one output vertex, and uniform/faceVarying values
    // answer None from the scatter (no face-driven slot exists).
    let mut orig_copies: Vec<Vec<u32>> = vec![Vec::new(); vertex_count];
    let mut first_corner: Vec<Option<usize>> = Vec::new();
    for (orig, slot) in orig_to_new.iter().enumerate() {
        if slot.is_some() {
            orig_copies[orig].push(first_corner.len() as u32);
            first_corner.push(None);
        }
    }
    let scatter = Scatter {
        orig_copies,
        first_corner,
    };
    let corners: Vec<(u32, usize, usize)> = Vec::new();
    let uvs = read_primvar::<Vec2f>(prim, "primvars:st", time_code, path)?
        .and_then(|(scope, values)| scatter.map(scope, values, &corners))
        .map(|per_vertex| per_vertex.into_iter().map(|v| [v.x, v.y]).collect());
    let colors = read_primvar::<Vec3f>(prim, "primvars:displayColor", time_code, path)?
        .and_then(|(scope, values)| scatter.map(scope, values, &corners))
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

/// One faceVarying stream feeding the split key, compared in raw f32 bits
/// (authored atlas UVs are exact).
enum Fv<'a> {
    Vec2(&'a [Vec2f]),
    Vec3(&'a [Vec3f]),
}

impl Fv<'_> {
    // A stream missing a value at any corner slot cannot key the split; it
    // is dropped here and the scatter below drops the whole primvar.
    fn covers(&self, corners: &[(u32, usize, usize)]) -> bool {
        let len = match self {
            Fv::Vec2(values) => values.len(),
            Fv::Vec3(values) => values.len(),
        };
        corners.iter().all(|&(_, slot, _)| slot < len)
    }

    fn key_at(&self, slot: usize) -> [u32; 3] {
        match self {
            Fv::Vec2(values) => {
                let value = &values[slot];
                [value.x.to_bits(), value.y.to_bits(), 0]
            }
            Fv::Vec3(values) => {
                let value = &values[slot];
                [value.x.to_bits(), value.y.to_bits(), value.z.to_bits()]
            }
        }
    }
}

/// Split output vertices per distinct faceVarying corner value: corners of
/// one original vertex whose values agree across every faceVarying stream
/// share an output vertex, disagreeing corners each get their own (position
/// duplicated), so every stream maps its corners exactly. Returns the
/// output positions, the primvar scatter bookkeeping, and each corner's
/// output vertex.
fn split_face_varying(
    normals: &Option<(Scope, Vec<Vec3f>)>,
    uvs: &Option<(Scope, Vec<Vec2f>)>,
    colors: &Option<(Scope, Vec<Vec3f>)>,
    corners: &[(u32, usize, usize)],
    base_positions: &[[f32; 3]],
    orig_to_new: &[Option<u32>],
) -> (Vec<[f32; 3]>, Scatter, Vec<u32>) {
    // The partition is the union every faceVarying stream induces.
    let streams: Vec<Fv> = [
        normals
            .as_ref()
            .map(|(scope, values)| (*scope, Fv::Vec3(values))),
        uvs.as_ref()
            .map(|(scope, values)| (*scope, Fv::Vec2(values))),
        colors
            .as_ref()
            .map(|(scope, values)| (*scope, Fv::Vec3(values))),
    ]
    .into_iter()
    .flatten()
    .filter(|(scope, _)| *scope == Scope::FaceVarying)
    .map(|(_, values)| values)
    .filter(|values| values.covers(corners))
    .collect();

    // Per original vertex: distinct corner keys and each key's first
    // corner, in face-walk order.
    let mut copy_keys: Vec<Vec<Vec<[u32; 3]>>> = vec![Vec::new(); orig_to_new.len()];
    let mut copy_corners: Vec<Vec<usize>> = vec![Vec::new(); orig_to_new.len()];
    let mut corner_copy: Vec<u32> = Vec::with_capacity(corners.len());
    for (index, &(vertex, slot, _face)) in corners.iter().enumerate() {
        let key: Vec<[u32; 3]> = streams.iter().map(|stream| stream.key_at(slot)).collect();
        let keys = &mut copy_keys[vertex as usize];
        let copy = match keys.iter().position(|other| *other == key) {
            Some(copy) => copy,
            None => {
                keys.push(key);
                copy_corners[vertex as usize].push(index);
                keys.len() - 1
            }
        };
        corner_copy.push(copy as u32);
    }

    // Output vertices in original-vertex order; a finite vertex no usable
    // face references still ships as one corner-less copy (compaction
    // behavior), which no face-driven primvar can map.
    let mut positions: Vec<[f32; 3]> = Vec::with_capacity(base_positions.len());
    let mut first_corner: Vec<Option<usize>> = Vec::with_capacity(base_positions.len());
    let mut orig_copies: Vec<Vec<u32>> = vec![Vec::new(); orig_to_new.len()];
    for (orig, slot) in orig_to_new.iter().enumerate() {
        let Some(compact) = slot else {
            continue;
        };
        let compact = *compact as usize;
        if copy_keys[orig].is_empty() {
            orig_copies[orig].push(positions.len() as u32);
            positions.push(base_positions[compact]);
            first_corner.push(None);
            continue;
        }
        for first in &copy_corners[orig] {
            orig_copies[orig].push(positions.len() as u32);
            positions.push(base_positions[compact]);
            first_corner.push(Some(*first));
        }
    }
    let corner_new = corners
        .iter()
        .zip(corner_copy)
        .map(|(&(vertex, _, _), copy)| orig_copies[vertex as usize][copy as usize])
        .collect();

    (
        positions,
        Scatter {
            orig_copies,
            first_corner,
        },
        corner_new,
    )
}

/// Primvar scatter bookkeeping over the split output vertices:
/// `orig_copies[orig]` lists the output-vertex ids the original vertex was
/// split into, and `first_corner[out]` is each output vertex's first
/// (face-walk order) corner — None for vertices no usable face references.
struct Scatter {
    orig_copies: Vec<Vec<u32>>,
    first_corner: Vec<Option<usize>>,
}

impl Scatter {
    /// Attribute values scattered to one entry per output vertex, or `None`
    /// when a demanded slot has no value — the caller drops the whole
    /// primvar instead of guessing.
    fn map<T: Clone>(
        &self,
        scope: Scope,
        values: Vec<T>,
        corners: &[(u32, usize, usize)],
    ) -> Option<Vec<T>> {
        if values.is_empty() {
            return None;
        }
        let out_count = self.first_corner.len();
        match scope {
            Scope::Constant => Some(vec![values.into_iter().next()?; out_count]),
            Scope::Vertex => {
                let mut out = Vec::with_capacity(out_count);
                for (orig, copies) in self.orig_copies.iter().enumerate() {
                    if copies.is_empty() {
                        continue;
                    }
                    let value = values.get(orig)?;
                    out.extend(copies.iter().map(|_| value.clone()));
                }
                Some(out)
            }
            // Uniform is one value per face, faceVarying one per corner
            // slot: each output vertex takes the value at its first corner
            // (split copies were keyed so all their corners agree).
            Scope::Uniform | Scope::FaceVarying => {
                let mut out = Vec::with_capacity(out_count);
                for first in &self.first_corner {
                    let (_, slot, face) = corners[(*first)?];
                    let index = if scope == Scope::Uniform { face } else { slot };
                    out.push(values.get(index)?.clone());
                }
                Some(out)
            }
        }
    }
}

/// Per-vertex area-weighted average of face normals (the cross product is
/// accumulated unnormalized); vertices with no valid face normal keep a zero
/// normal. `orig_copies` merges the accumulators of one original vertex's
/// faceVarying split copies so generated normals stay smooth across UV seams.
fn generated_normals(
    positions: &[[f32; 3]],
    indices: &[u32],
    orig_copies: &[Vec<u32>],
) -> Vec<[f32; 3]> {
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
    // Split copies of one original vertex share the area-weighted sum over
    // ALL its faces; all copies share a position, so the face normals are
    // identical to the unsplit vertex's.
    for copies in orig_copies {
        let mut merged = [0.0f32; 3];
        for &out in copies {
            for axis in 0..3 {
                merged[axis] += accumulators[out as usize][axis];
            }
        }
        for &out in copies {
            accumulators[out as usize] = merged;
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
