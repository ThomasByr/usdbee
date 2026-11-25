use std::path::PathBuf;

use usdbee_lib::stage::{open_stage, serialize_render_manifest, RenderNode};
use usdbee_lib::tessellation::{tessellate_prim, MeshData};

use openusd::sdf;
use openusd::usd::Prim;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn prim(stage: &openusd::usd::Stage, path: &str) -> Result<Prim, String> {
    let prim_path = sdf::try_into_path(path)
        .map_err(|e| format!("invalid test prim path '{}': {}", path, e))?;
    stage.prim(prim_path).map_err(|e| e.to_string())
}

fn tessellate_stage(name: &str) -> (openusd::usd::Stage, usdbee_lib::stage::StageInfo) {
    open_stage(&fixture(name)).expect("curves/points stage should open")
}

fn tessellate(stage: &openusd::usd::Stage, path: &str) -> Option<MeshData> {
    tessellate_prim(&prim(stage, path).expect("test prim should resolve"), None)
        .expect("tessellation should not fail for the tested prim")
}

fn find_node<'a>(nodes: &'a [RenderNode], path: &str) -> Option<&'a RenderNode> {
    nodes
        .iter()
        .find(|n| n.path == path)
        .or_else(|| nodes.iter().find_map(|n| find_node(&n.children, path)))
}

#[test]
fn basic_usda_mesh_matches_authored_counts_and_bounds() {
    let (stage, _info) = open_stage(&fixture("basic.usda")).expect("basic stage should open");

    let mesh = tessellate(&stage, "/World/Ball").expect("Ball should be a mesh");

    assert_eq!(
        mesh.positions,
        [[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
    );
    assert_eq!(
        mesh.indices,
        [0, 1, 2],
        "one authored triangle fans to itself"
    );
    assert!(mesh.uvs.is_none(), "basic.usda authors no st primvar");
    // Unauthored normals are generated here (controller resolution for
    // Task 1): the single triangle's face normal, normalized, is (0, 0, 1).
    assert_eq!(
        mesh.normals,
        Some(vec![[0.0, 0.0, 1.0], [0.0, 0.0, 1.0], [0.0, 0.0, 1.0]])
    );
    // The fixture DOES author displayColor, so colors are Some — the brief's
    // "colors present: None" note predates this fixture's displayColor.
    assert_eq!(
        mesh.colors,
        Some(vec![[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]])
    );
}

#[test]
fn mesh_primvars_golden_first_and_last_primvar_values() {
    let (stage, _info) =
        open_stage(&fixture("mesh_primvars.usda")).expect("mesh_primvars stage should open");

    let mesh = tessellate(&stage, "/Scene/Panel").expect("Panel should be a mesh");

    // Faces [4, 3, 2]: the quad and the triangle fan to 3 triangles, the
    // 2-vertex degenerate face contributes none.
    assert_eq!(mesh.indices, vec![0, 1, 2, 0, 2, 3, 0, 2, 4]);
    assert_eq!(mesh.positions.len(), 5);

    let normals = mesh.normals.expect("Panel authors normals");
    assert_eq!(normals.len(), 5);
    assert_eq!(normals[0], [0.0, 0.0, 1.0]);
    assert_eq!(normals[4], [0.0, 1.0, 0.0]);

    let uvs = mesh.uvs.expect("Panel authors primvars:st");
    assert_eq!(uvs.len(), 5);
    assert_eq!(uvs[0], [0.0, 0.0]);
    assert_eq!(uvs[4], [2.0, 3.0]);

    let colors = mesh.colors.expect("Panel authors primvars:displayColor");
    assert_eq!(colors.len(), 5);
    assert_eq!(colors[0], [0.25, 0.5, 0.75]);
    assert_eq!(colors[4], [0.25, 0.5, 0.75]);
}

#[test]
fn facevarying_uv_seam_splits_the_shared_vertex_per_face() {
    use usdbee_lib::tessellation::pack_geometry;

    let (stage, _info) = tessellate_stage("uv_seam.usda");

    let mesh = tessellate(&stage, "/Scene/Seam").expect("seam mesh should tessellate");

    // 4 authored points -> 5 output vertices: only the seam vertex (2)
    // splits, once per face; the vertex whose corners agree stays shared.
    assert_eq!(mesh.positions.len(), 5);
    assert_eq!(mesh.indices, vec![0, 1, 2, 3, 1, 4]);
    let uvs = mesh.uvs.clone().expect("Seam authors faceVarying st");
    assert_eq!(uvs[2], [0.25, 0.25], "face 0's own corner value");
    assert_eq!(uvs[3], [0.75, 0.25], "face 1's own corner value");

    // Packed bytes carry the split too: the header count and the seam
    // vertex's two copies each keep their face's UV.
    let packed = pack_geometry(&mesh);
    assert_eq!(
        u32::from_le_bytes(packed[8..12].try_into().unwrap()),
        5,
        "split vertex count reaches the wire header"
    );
    let uv_base =
        20 + mesh.positions.len() * 12 + mesh.normals.as_ref().map_or(0, |n| n.len() * 12);
    let uv_at = |index: usize| {
        let offset = uv_base + index * 8;
        [
            f32::from_le_bytes(packed[offset..offset + 4].try_into().unwrap()),
            f32::from_le_bytes(packed[offset + 4..offset + 8].try_into().unwrap()),
        ]
    };
    assert_eq!(uv_at(2), [0.25, 0.25]);
    assert_eq!(uv_at(3), [0.75, 0.25]);
}

#[test]
fn non_coplanar_uv_seam_keeps_one_smooth_normal_across_split_copies() {
    let (stage, _info) = tessellate_stage("uv_seam.usda");

    let mesh = tessellate(&stage, "/Scene/Fold").expect("fold mesh should tessellate");

    // Same split as the coplanar Seam mesh: only the seam vertex doubles.
    assert_eq!(mesh.positions.len(), 5);
    assert_eq!(mesh.indices, vec![0, 1, 2, 3, 1, 4]);
    let normals = mesh.normals.expect("unauthored normals are generated");
    assert_eq!(normals.len(), 5);
    // Face 0 lies in the XY plane (normal (0, 0, 1)); face 1 tilts in Z
    // (unnormalized cross (-0.5, -0.5, 1)). The merged area-weighted normal
    // is (-0.5, -0.5, 2) normalized.
    let merged = [-0.235_702_26, -0.235_702_26, 0.942_809];
    for &copy in &[2, 3] {
        assert!(
            normals[copy]
                .iter()
                .zip(merged)
                .all(|(a, b)| (a - b).abs() < 1e-5),
            "split copy {} must carry the merged fold normal, got {:?}",
            copy,
            normals[copy]
        );
    }
    // Unsplit vertices of a single face keep that face's own normal.
    assert_eq!(normals[0], [0.0, 0.0, 1.0]);
}

#[test]
fn agreeing_facevarying_corners_keep_vertices_shared() {
    let (stage, _info) = tessellate_stage("uv_seam.usda");

    let mesh = tessellate(&stage, "/Scene/Control").expect("control mesh should tessellate");

    // No corner disagreement: the seam-free mesh keeps one output vertex
    // per input vertex (no vertex-count bloat).
    assert_eq!(mesh.positions.len(), 4);
    assert_eq!(mesh.indices, vec![0, 1, 2, 2, 1, 3]);
    let uvs = mesh.uvs.expect("Control authors faceVarying st");
    assert_eq!(uvs.len(), 4);
    assert_eq!(uvs[2], [0.25, 0.25]);
}

#[test]
fn facevarying_display_color_seam_splits_too() {
    let (stage, _info) = tessellate_stage("uv_seam.usda");

    let mesh = tessellate(&stage, "/Scene/ColorSeam").expect("color seam should tessellate");

    // The split is driven by ALL faceVarying streams: displayColor alone
    // induces the same partition st does.
    assert_eq!(mesh.positions.len(), 5);
    assert_eq!(mesh.indices, vec![0, 1, 2, 3, 1, 4]);
    let colors = mesh
        .colors
        .expect("ColorSeam authors faceVarying displayColor");
    assert_eq!(colors[2], [1.0, 0.0, 0.0]);
    assert_eq!(colors[3], [0.0, 0.0, 1.0]);
    assert!(mesh.uvs.is_none());
}

#[test]
fn uniform_primvar_scatters_by_face_to_surviving_vertices() {
    // Uniform values are one per face: each face's value must scatter to that
    // face's surviving vertices (shared vertices keep the first face's
    // value), never to a per-corner slot.
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let path = dir.path().join("uniform_colors.usda");
    std::fs::write(
        &path,
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def Mesh \"Strip\"\n{\n",
            "        int[] faceVertexCounts = [4, 3]\n",
            "        int[] faceVertexIndices = [0, 1, 2, 3, 1, 2, 4]\n",
            "        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (2, 0, 0)]\n",
            "        color3f[] primvars:displayColor = [(1, 0, 0), (0, 0, 1)] (\n",
            "            interpolation = \"uniform\"\n",
            "        )\n",
            "    }\n",
            "}\n",
        ),
    )
    .expect("test stage should be written");

    let (stage, _info) = open_stage(&path).expect("stage should open");
    let mesh = tessellate(&stage, "/Scene/Strip").expect("mesh should tessellate");

    assert_eq!(mesh.indices, vec![0, 1, 2, 0, 2, 3, 1, 2, 4]);
    assert_eq!(mesh.positions.len(), 5);
    // Faces [0,1,2,3] (red) and [1,2,4] (blue): vertices 0-3 belong to the
    // quad first, vertex 4 only to the triangle.
    assert_eq!(
        mesh.colors,
        Some(vec![
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0]
        ])
    );
}

#[test]
fn nan_vertex_is_dropped_with_its_index_entries() {
    // Deep validation contract: a NaN/inf position cannot be sent to the GPU,
    // so the vertex is compacted away, positions/index arrays are remapped,
    // and no index entry may reference the dropped vertex.
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let path = dir.path().join("nan_mesh.usda");
    std::fs::write(
        &path,
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def Mesh \"Fractured\"\n{\n",
            "        int[] faceVertexCounts = [3, 3]\n",
            "        int[] faceVertexIndices = [0, 1, 2, 1, 2, 3]\n",
            "        point3f[] points = [(0, 0, 0), (NAN, NAN, NAN), (2, 0, 0), (0, 1, 0)]\n",
            "        color3f[] primvars:displayColor = [(1, 1, 1)]\n",
            "    }\n",
            "}\n",
        ),
    )
    .expect("test stage should be written");

    let (stage, _info) = open_stage(&path).expect("nan stage should open");
    let mesh = tessellate(&stage, "/Scene/Fractured").expect("nan mesh should not fail");

    assert_eq!(
        mesh.positions,
        [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        "the NaN vertex is compacted out, survivors remap"
    );
    // Face [0,1,2] referenced the dropped vertex: gone. Face [1,2,3] loses
    // this vertex too, so both authored triangles are unrenderable — every
    // index entry referencing the dropped vertex disappears.
    assert_eq!(mesh.indices, Vec::<u32>::new());
    assert_eq!(
        mesh.colors,
        Some(vec![[1.0, 1.0, 1.0], [1.0, 1.0, 1.0], [1.0, 1.0, 1.0]])
    );
}

#[test]
fn generated_normals_average_face_normals_per_vertex() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let path = dir.path().join("no_normals.usda");
    std::fs::write(
        &path,
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def Mesh \"Hull\"\n{\n",
            "        int[] faceVertexCounts = [3]\n",
            "        int[] faceVertexIndices = [0, 1, 2]\n",
            "        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 0, -1)]\n",
            "    }\n",
            "}\n",
        ),
    )
    .expect("test stage should be written");

    let (stage, _info) = open_stage(&path).expect("stage should open");
    let mesh = tessellate(&stage, "/Scene/Hull").expect("mesh should tessellate");

    let normals = mesh.normals.expect("unauthored normals are generated");
    assert_eq!(normals.len(), 3);
    // Face normal of ((1,0,0)-(0,0,0)) x ((0,0,-1)-(0,0,0)) — right-hand
    // counter-clockwise winding gives (0, 1, 0) up to unit length.
    assert!(normals.iter().all(|n| (n[1] - 1.0).abs() < 1e-6));
}

#[test]
fn sphere_tessellates_with_fixed_density_unit_normals_and_uvs() {
    let (stage, _) = open_stage(&fixture("variants.usda")).expect("variants stage should open");
    let sphere = tessellate(&stage, "/Prop/Shape").expect("Sphere should tessellate");

    assert_eq!(sphere.positions.len(), 25 * 13);
    assert_eq!(sphere.indices.len(), 24 * 22 * 3);
    assert!(sphere.positions.iter().all(|position| {
        let length = position
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        (length - 1.0).abs() < 1e-5
    }));
    let normals = sphere.normals.expect("analytic sphere normals");
    assert_eq!(normals.len(), sphere.positions.len());
    assert!(normals.iter().all(|normal| {
        let length = normal.iter().map(|value| value * value).sum::<f32>().sqrt();
        (length - 1.0).abs() < 1e-5
    }));
    let uvs = sphere.uvs.expect("sphere texture coordinates");
    assert_eq!(uvs.len(), sphere.positions.len());
    assert_eq!(uvs[0], [0.0, 0.0]);
    assert_eq!(uvs[25], [0.0, 1.0 / 12.0]);
}

#[test]
fn large_animated_mesh_tessellates_and_packs_at_both_time_samples() {
    use std::fmt::Write as _;
    use usdbee_lib::tessellation::pack_geometry;

    const VERTICES: usize = 100_000;
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let path = dir.path().join("large_animated.usda");
    let mut source = String::with_capacity(VERTICES * 45);
    source.push_str("#usda 1.0\n\ndef Mesh \"Large\" {\n");
    writeln!(source, "int[] faceVertexCounts = [{VERTICES}]").unwrap();
    source.push_str("int[] faceVertexIndices = [");
    for index in 0..VERTICES {
        write!(source, "{index},").unwrap();
    }
    source.push_str("]\npoint3f[] points.timeSamples = {\n");
    for (time, offset) in [(0, 0.0), (10, 1.0)] {
        writeln!(source, "{time}: [").unwrap();
        for index in 0..VERTICES {
            write!(source, "({}, {}, 0),", index as f32 + offset, index % 2).unwrap();
        }
        source.push_str("],\n");
    }
    source.push_str("}\n}\n");
    std::fs::write(&path, source).expect("large stage should be written");

    let (stage, _) = open_stage(&path).expect("large stage should open");
    let large = prim(&stage, "/Large").expect("large prim should resolve");
    let first = tessellate_prim(&large, Some(0.0))
        .expect("time 0 should tessellate")
        .expect("mesh data at time 0");
    let second = tessellate_prim(&large, Some(10.0))
        .expect("time 10 should tessellate")
        .expect("mesh data at time 10");

    for mesh in [&first, &second] {
        assert_eq!(mesh.positions.len(), VERTICES);
        assert_eq!(mesh.indices.len(), (VERTICES - 2) * 3);
        let packed = pack_geometry(mesh);
        assert_eq!(
            u32::from_le_bytes(packed[8..12].try_into().unwrap()),
            VERTICES as u32
        );
        assert_eq!(
            u32::from_le_bytes(packed[12..16].try_into().unwrap()),
            (VERTICES - 2) as u32 * 3
        );
    }
    assert_ne!(first.positions[1], second.positions[1]);
}

#[test]
fn non_geometry_prim_tessellates_to_none() {
    let (stage, _info) = open_stage(&fixture("basic.usda")).expect("basic stage should open");

    let world = prim(&stage, "/World").expect("World should resolve");
    let none = tessellate_prim(&world, Some(1.0)).expect("xform must not fail");
    assert!(none.is_none(), "an Xform is not geometry");
}

#[test]
fn authored_empty_face_counts_produce_no_indices() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let path = dir.path().join("empty_topology.usda");
    std::fs::write(
        &path,
        concat!(
            "#usda 1.0\n\ndef Mesh \"Empty\" {\n",
            "int[] faceVertexCounts = []\n",
            "int[] faceVertexIndices = []\n",
            "point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]\n",
            "}\n",
        ),
    )
    .expect("test stage should be written");
    let (stage, _) = open_stage(&path).expect("stage should open");

    let mesh = tessellate(&stage, "/Empty").expect("empty topology should tessellate");
    assert!(mesh.indices.is_empty());
}

#[test]
fn zero_area_fan_triangles_are_skipped() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let path = dir.path().join("zero_area.usda");
    std::fs::write(
        &path,
        concat!(
            "#usda 1.0\n\ndef Mesh \"Degenerate\" {\n",
            "int[] faceVertexCounts = [3, 3, 3]\n",
            "int[] faceVertexIndices = [0, 1, 2, 3, 3, 4, 0, 2, 4]\n",
            "point3f[] points = [(0, 0, 0), (1, 0, 0), (2, 0, 0), (5, 0, 0), (0, 1, 0)]\n",
            "}\n",
        ),
    )
    .expect("test stage should be written");
    let (stage, _) = open_stage(&path).expect("stage should open");

    let mesh = tessellate(&stage, "/Degenerate").expect("degenerate faces must not fail");
    assert_eq!(mesh.indices, [0, 2, 4]);
}

#[test]
fn mesh_without_topology_is_a_readable_error() {
    // The stage builder registers the openusd-schemas registry (Task 3),
    // which activates schema-declared fallbacks. Mesh topology declares no
    // fallback, so a mesh without faceVertexCounts must stay an Err instead
    // of composing a default.
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let path = dir.path().join("topologyless.usda");
    std::fs::write(
        &path,
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def Mesh \"Empty\"\n{\n",
            "        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]\n",
            "    }\n",
            "}\n",
        ),
    )
    .expect("test stage should be written");

    let (stage, _info) = open_stage(&path).expect("stage should open");
    let error = tessellate_prim(&prim(&stage, "/Scene/Empty").expect("prim resolves"), None)
        .expect_err("missing topology is an error, not a fallback");
    assert!(error.contains("faceVertexCounts"), "got: {}", error);
}

#[test]
fn curve_tessellates_to_six_sided_tube_with_pinned_counts() {
    let (stage, _info) = tessellate_stage("curves_points.usda");

    let mesh = tessellate(&stage, "/Scene/Stroke").expect("curve should tessellate");

    // Controller-pinned counts: one curve of n=4 points welds to 4 rings of
    // CURVE_SIDES vertices, and 3 quad blocks of 6 quads = 36 indices each.
    assert_eq!(mesh.positions.len(), 4 * 6);
    assert_eq!(mesh.indices.len(), 3 * 36);
    assert_eq!(mesh.normals.as_ref().map(|n| n.len()), Some(24));

    // Curves render as tubes with no authored primvars: uvs/colors stay
    // unset (the bound material color applies, controller resolution).
    assert!(mesh.uvs.is_none());
    assert!(mesh.colors.is_none());

    // Winding pinned: first quad of the first block, and the last indices
    // close the last ring pair back on k=0.
    assert_eq!(&mesh.indices[0..6], &[0u32, 1, 7, 0, 7, 6]);
    assert_eq!(&mesh.indices[105..108], &[17u32, 18, 23]);
}

#[test]
fn curve_ring_vertices_sit_at_radius_from_their_points() {
    let (stage, _info) = tessellate_stage("curves_points.usda");

    let mesh = tessellate(&stage, "/Scene/Stroke").expect("curve should tessellate");

    let radius = 0.1f32;
    let points = [
        [0.0f32, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [2.0, 1.0, 0.0],
    ];
    for (vertex, position) in mesh.positions.iter().enumerate() {
        let ring = vertex / 6;
        let center = points[ring];
        // The chain's ends keep the plain radius; the two 90 degree corners
        // are mitred out by 1 / cos(45 deg).
        let scale = if ring == 0 || ring == points.len() - 1 {
            1.0
        } else {
            2f32.sqrt()
        };
        let distance_sq = (position[0] - center[0]).powi(2)
            + (position[1] - center[1]).powi(2)
            + (position[2] - center[2]).powi(2);
        assert!(
            (distance_sq - radius * radius * scale * scale).abs() < 1e-6,
            "vertex {vertex} at {position:?} is not at radius from center {center:?}"
        );
    }
}

#[test]
fn bent_curve_rings_are_perpendicular_to_their_frame_tangent() {
    let (stage, _info) = tessellate_stage("curves_points.usda");
    let mesh = tessellate(&stage, "/Scene/Stroke").expect("curve should tessellate");

    // Ring 1 sits on the corner (1,0,0) between +X and +Y, so its plane
    // faces the bisector (1,1,0)/sqrt(2): every radial vector is
    // perpendicular to it, and none follows a single segment's tangent.
    let corner = [1.0f32, 0.0, 0.0];
    for position in &mesh.positions[6..12] {
        let radial = [
            position[0] - corner[0],
            position[1] - corner[1],
            position[2] - corner[2],
        ];
        let along = (radial[0] + radial[1]) / 2f32.sqrt();
        assert!(
            along.abs() < 1e-5,
            "ring vertex {position:?} uses the wrong frame (offset {along})"
        );
    }
    // The chain's first ring faces the first segment's tangent +X.
    for position in &mesh.positions[0..6] {
        let radial_x = position[0];
        assert!(
            radial_x.abs() < 1e-6,
            "ring vertex {position:?} uses the wrong frame"
        );
    }
}

#[test]
fn curve_tube_normals_are_radial_and_unit_length() {
    let (stage, _info) = tessellate_stage("curves_points.usda");

    let mesh = tessellate(&stage, "/Scene/Stroke").expect("curve should tessellate");

    let normals = mesh.normals.expect("tube normals are generated radially");
    // Segment 0's frame: tangent (1, 0, 0) fixes u = (0, 0, 1) ring vertex
    // 0, so normal[0] points along u and normal[1] at theta = 60 deg.
    assert!(normals[0][2] > 0.99, "got {:?}", normals[0]);
    assert!(
        normals[1][2] > 0.49 && normals[1][1] < -0.49,
        "got {:?}",
        normals[1]
    );
    for normal in &normals {
        let length = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
        assert!((length - 1.0).abs() < 1e-5, "not unit: {normal:?}");
    }
}

/// Tube cross-section sides (the tessellator's CURVE_SIDES).
const SIDES: usize = 6;

/// A 3-point polyline: the smallest tube with an interior (welded) ring.
fn three_point_scene() -> (tempfile::TempDir, openusd::usd::Stage) {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let stage = open_scene(
        &dir,
        "three_points.usda",
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def BasisCurves \"Bend\"\n{\n",
            "        int[] curveVertexCounts = [3]\n",
            "        point3f[] points = [(0, 0, 0), (0.5, 0, 0), (0.5, 0.5, 0)]\n",
            "        float[] widths = [0.2]\n",
            "    }\n",
            "}\n",
        ),
    );
    (dir, stage)
}

#[test]
fn curve_tube_welds_one_ring_per_point() {
    let (_dir, stage) = three_point_scene();

    let mesh = tessellate(&stage, "/Scene/Bend").expect("curve should tessellate");

    // One 6-vertex ring per point: 3 rings, and 2 quad blocks of 6 quads.
    assert_eq!(mesh.positions.len(), 3 * SIDES);
    assert_eq!(mesh.indices.len(), 2 * SIDES * 6);
    assert_eq!(mesh.normals.as_ref().map(|n| n.len()), Some(3 * SIDES));
    assert_eq!(
        mesh.indices.iter().max(),
        Some(&((3 * SIDES - 1) as u32)),
        "no vertex is duplicated per segment"
    );
}

#[test]
fn curve_tube_shares_the_corner_ring_between_adjacent_quads() {
    let (_dir, stage) = three_point_scene();

    let mesh = tessellate(&stage, "/Scene/Bend").expect("curve should tessellate");

    let (first, second) = mesh.indices.split_at(SIDES * 6);
    assert_eq!(
        first.iter().max(),
        Some(&((2 * SIDES - 1) as u32)),
        "the first quad block ends on the corner ring"
    );
    assert_eq!(
        second.iter().min(),
        Some(&(SIDES as u32)),
        "the second quad block starts on the same corner ring"
    );
}

#[test]
fn curve_tube_miters_a_ninety_degree_corner_into_one_ring() {
    // Stroke turns 90 degrees at (1, 0, 0). The corner is ONE ring in the
    // plane perpendicular to the bisector (1, 1, 0)/sqrt(2), grown by the
    // miter factor 1/cos(45 deg) so both segments meet on it.
    let (stage, _info) = tessellate_stage("curves_points.usda");
    let mesh = tessellate(&stage, "/Scene/Stroke").expect("curve should tessellate");

    let corner = [1.0f32, 0.0, 0.0];
    let expected = 0.1 * 2f32.sqrt();
    for position in &mesh.positions[SIDES..2 * SIDES] {
        let delta = [
            position[0] - corner[0],
            position[1] - corner[1],
            position[2] - corner[2],
        ];
        let distance = delta.iter().map(|value| value * value).sum::<f32>().sqrt();
        assert!(
            (distance - expected).abs() < 1e-5,
            "corner vertex {position:?} sits {distance} from the corner, not the mitred {expected}"
        );
        let along = (delta[0] + delta[1]) / 2f32.sqrt();
        assert!(
            along.abs() < 1e-5,
            "corner vertex {position:?} left the miter plane (offset {along})"
        );
    }
}

#[test]
fn curve_tube_miter_scale_is_clamped_on_a_reversal() {
    // B -> A + tiny offset is a near reversal: 1/cos(half_angle) diverges, so
    // the miter must stop at 4x instead of shooting a spike (or a NaN).
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let stage = open_scene(
        &dir,
        "reversal.usda",
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def BasisCurves \"Fold\"\n{\n",
            "        int[] curveVertexCounts = [3]\n",
            "        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 0.001, 0)]\n",
            "        float[] widths = [0.2]\n",
            "    }\n",
            "}\n",
        ),
    );

    let mesh = tessellate(&stage, "/Scene/Fold").expect("a reversal must not fail");
    let points = [[0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.001, 0.0]];
    let radius = 0.1f32;
    assert_eq!(mesh.positions.len(), 3 * SIDES);
    for (vertex, position) in mesh.positions.iter().enumerate() {
        for axis in 0..3 {
            assert!(
                position[axis].is_finite(),
                "vertex {vertex} is not finite: {position:?}"
            );
        }
        let center = points[vertex / SIDES];
        let distance = ((position[0] - center[0]).powi(2)
            + (position[1] - center[1]).powi(2)
            + (position[2] - center[2]).powi(2))
        .sqrt();
        assert!(
            distance <= radius * 4.0 + 1e-5,
            "vertex {position:?} sits {distance} from {center:?}, past the 4x miter clamp"
        );
    }
}

#[test]
fn degenerate_one_point_curve_tessellates_to_nothing() {
    let (stage, _info) = tessellate_stage("curves_points.usda");

    // A degenerate curve contributes nothing (degenerate-face discipline):
    // the prim does not fail, it just renders no geometry.
    let mesh = tessellate(&stage, "/Scene/Dot").expect("degenerate curve must not fail");
    assert_eq!(mesh.positions, Vec::<[f32; 3]>::new());
    assert_eq!(mesh.indices, Vec::<u32>::new());
    assert_eq!(mesh.normals, None);
}

#[test]
fn points_prim_tessellates_to_positions_only() {
    let (stage, _info) = tessellate_stage("curves_points.usda");

    let mesh = tessellate(&stage, "/Scene/Dust").expect("points prim should tessellate");

    assert_eq!(
        mesh.positions,
        vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0]
        ]
    );
    assert_eq!(mesh.indices, Vec::<u32>::new());
    assert_eq!(mesh.normals, None, "points carry no normals");
    assert_eq!(mesh.uvs, None);
    // Vertex-interpolated displayColor scatters per point.
    assert_eq!(
        mesh.colors,
        Some(vec![
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 1.0, 0.0]
        ])
    );
}

/// The evaluated points a tube passes through: the six ring vertices of one
/// ring average back to their center (a regular hexagon is centered on it),
/// so the tube output exposes the curve the tessellator sampled.
fn ring_centers(mesh: &MeshData) -> Vec<[f32; 3]> {
    mesh.positions
        .chunks_exact(6)
        .map(|ring| {
            let mut center = [0.0f32; 3];
            for vertex in ring {
                for (axis, value) in vertex.iter().enumerate() {
                    center[axis] += value / 6.0;
                }
            }
            center
        })
        .collect()
}

/// Shortest distance from `point` to the polyline through `points`.
fn distance_to_polyline(point: [f32; 3], points: &[[f32; 3]]) -> f32 {
    points
        .windows(2)
        .map(|pair| {
            let (a, b) = (pair[0], pair[1]);
            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let ap = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
            let length_sq = ab.iter().map(|value| value * value).sum::<f32>();
            let t = if length_sq > 0.0 {
                ((ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / length_sq).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let delta = [ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t];
            delta.iter().map(|value| value * value).sum::<f32>().sqrt()
        })
        .fold(f32::INFINITY, f32::min)
}

/// Writes `contents` into `dir` and opens it as a stage.
fn open_scene(dir: &tempfile::TempDir, name: &str, contents: &str) -> openusd::usd::Stage {
    let path = dir.path().join(name);
    std::fs::write(&path, contents).expect("test stage should be written");
    open_stage(&path).expect("stage should open").0
}

#[test]
fn nurbs_curve_bows_off_the_chords_its_basis_counterpart_follows() {
    let (stage, _info) = tessellate_stage("nurbs_curves.usda");

    let nurbs = tessellate(&stage, "/Scene/C_nurbs").expect("nurbs curve must tessellate");
    let basis = tessellate(&stage, "/Scene/C_basis").expect("basis curve must tessellate");
    let control = [
        [1.0f32, 0.0, 0.0],
        [0.7, 0.7, 0.0],
        [0.0, 1.0, 0.0],
        [-0.7, 0.7, 0.0],
    ];

    // The basis curve stays a chord polygon (Round 1 byte identity): one
    // welded ring per control point, 3 quad blocks of 36 indices.
    assert_eq!(basis.positions.len(), 24);
    assert_eq!(basis.indices.len(), 108);
    // One ring per control point, no duplicated shared endpoints.
    let chords = [control[0], control[1], control[2], control[3]];
    for (center, point) in ring_centers(&basis).iter().zip(chords) {
        for axis in 0..3 {
            assert!(
                (center[axis] - point[axis]).abs() < 1e-6,
                "basis ring {center:?} left its control point {point:?}"
            );
        }
    }

    // The NURBS curve evaluates its curvature instead of its chords.
    assert_ne!(
        nurbs.positions, basis.positions,
        "de Boor must not emit the control polygon"
    );
    let centers = ring_centers(&nurbs);
    assert!(
        centers.len() > ring_centers(&basis).len(),
        "the arc is sampled more finely than its chords"
    );
    // A clamped curve interpolates the first and last control point.
    for (center, point) in [
        (centers[0], control[0]),
        (*centers.last().expect("samples"), control[3]),
    ] {
        for axis in 0..3 {
            assert!(
                (center[axis] - point[axis]).abs() < 1e-5,
                "curve endpoint {center:?} does not interpolate {point:?}"
            );
        }
    }
    // Non-uniform weights make the interior bow away from the chords.
    let off = centers
        .iter()
        .map(|center| distance_to_polyline(*center, &control))
        .fold(0.0f32, f32::max);
    assert!(
        off > 0.05,
        "the weighted arc must leave the control polygon, max offset {off}"
    );
    assert_eq!(
        nurbs.normals.as_ref().map(|values| values.len()),
        Some(nurbs.positions.len()),
        "every tube ring vertex keeps its radial normal"
    );

    // The manifest counts both curves as geometry: a nurbs-only asset must
    // not open to an empty viewport.
    let manifest = serialize_render_manifest(&stage, None).expect("manifest should serialize");
    let nurbs_node = find_node(&manifest, "/Scene/C_nurbs").expect("nurbs prim stays in the tree");
    assert!(nurbs_node.has_geometry, "nurbs curve renders geometry");
    let geometry_count = count_geometry(&manifest);
    assert_eq!(geometry_count, 2, "both curves count as geometry");
}

#[test]
fn rational_quadratic_nurbs_samples_stay_on_the_unit_circle() {
    // Known answer: weights (1, sqrt(2)/2, 1) with clamped knots
    // [0,0,0,1,1,1] make a quadratic NURBS that is EXACTLY the first
    // quadrant of the unit circle.
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let stage = open_scene(
        &dir,
        "quarter_circle.usda",
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def NurbsCurves \"Arc\"\n{\n",
            "        int[] curveVertexCounts = [3]\n",
            "        point3f[] points = [(1, 0, 0), (1, 1, 0), (0, 1, 0)]\n",
            "        int[] order = [3]\n",
            "        double[] knots = [0, 0, 0, 1, 1, 1]\n",
            "        double[] pointWeights = [1, 0.7071067811865476, 1]\n",
            "        double2[] ranges = [(0, 1)]\n",
            "        float[] widths = [0.02]\n",
            "    }\n",
            "}\n",
        ),
    );

    let mesh = tessellate(&stage, "/Scene/Arc").expect("nurbs arc should tessellate");
    let centers = ring_centers(&mesh);

    // One knot span at 8 samples: 9 evaluated points, so 9 welded rings.
    assert_eq!(centers.len(), 9);
    for (center, point) in [
        (centers[0], [1.0f32, 0.0, 0.0]),
        (centers[8], [0.0, 1.0, 0.0]),
    ] {
        for axis in 0..3 {
            assert!(
                (center[axis] - point[axis]).abs() < 1e-5,
                "arc endpoint {center:?} does not interpolate {point:?}"
            );
        }
    }
    for center in &centers {
        let length = (center[0] * center[0] + center[1] * center[1] + center[2] * center[2]).sqrt();
        assert!(
            (length - 1.0).abs() < 1e-4,
            "sample {center:?} is off the unit circle (|p| = {length})"
        );
    }
    // The chords (1,0)->(1,1)->(0,1) sit far off the arc.
    let chords = [[1.0f32, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]];
    let off = centers
        .iter()
        .map(|center| distance_to_polyline(*center, &chords))
        .fold(0.0f32, f32::max);
    assert!(off > 0.1, "the arc must leave the chords, max offset {off}");
}

/// The 6-point clamped uniform cubic: order 4, three knot spans over [0, 3].
/// `ranges` is pasted as an authored attribute line (empty for no range).
fn clamped_cubic_scene(ranges: &str) -> String {
    format!(
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{{\n",
            "    def NurbsCurves \"Cubic\"\n{{\n",
            "        int[] curveVertexCounts = [6]\n",
            "        point3f[] points = [(0, 0, 0), (1, 1, 0), (2, 1.5, 0), (3, 0.5, 0), (4, 1, 0), (5, 0, 0)]\n",
            "        int[] order = [4]\n",
            "        double[] knots = [0, 0, 0, 0, 1, 2, 3, 3, 3, 3]\n",
            "        {}\n",
            "        float[] widths = [0.04]\n",
            "    }}\n",
            "}}\n",
        ),
        ranges
    )
}

#[test]
fn clamped_cubic_nurbs_samples_interpolate_ends_and_leave_the_chords() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let stage = open_scene(&dir, "cubic.usda", &clamped_cubic_scene(""));
    let control = [
        [0.0f32, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [2.0, 1.5, 0.0],
        [3.0, 0.5, 0.0],
        [4.0, 1.0, 0.0],
        [5.0, 0.0, 0.0],
    ];

    let mesh = tessellate(&stage, "/Scene/Cubic").expect("cubic should tessellate");
    let centers = ring_centers(&mesh);

    // 8 samples per span over 3 spans, plus the domain end: 25 evaluated
    // points, i.e. 25 welded rings. The sample count grows with the span
    // count and exceeds the 5 control chords.
    assert_eq!(centers.len(), 3 * 8 + 1);
    assert!(centers.len() > control.len());
    for (center, point) in [
        (centers[0], control[0]),
        (*centers.last().expect("samples"), control[5]),
    ] {
        for axis in 0..3 {
            assert!(
                (center[axis] - point[axis]).abs() < 1e-5,
                "curve endpoint {center:?} does not interpolate {point:?}"
            );
        }
    }
    // Interior samples must sit off the control polygon.
    let interior = &centers[1..centers.len() - 1];
    let off = interior
        .iter()
        .map(|center| distance_to_polyline(*center, &control))
        .fold(0.0f32, f32::max);
    assert!(
        off > 0.1,
        "interior samples stay on the chords, max offset {off}"
    );
}

#[test]
fn nurbs_curve_with_inconsistent_knots_falls_back_to_its_control_polygon() {
    // Order 3 over 3 points needs 3 + 3 knots; this prim authors 5. The prim
    // must still render (fail-soft) and keep the Round 1 chord behaviour.
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let stage = open_scene(
        &dir,
        "broken_knots.usda",
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def NurbsCurves \"Broken\"\n{\n",
            "        int[] curveVertexCounts = [3]\n",
            "        point3f[] points = [(0, 0, 0), (1, 1, 0), (2, 0, 0)]\n",
            "        int[] order = [3]\n",
            "        double[] knots = [0, 0, 0, 1, 1]\n",
            "        float[] widths = [0.04]\n",
            "    }\n",
            "}\n",
        ),
    );

    let mesh = tessellate(&stage, "/Scene/Broken").expect("a broken nurbs prim must not fail");
    let control = [[0.0f32, 0.0, 0.0], [1.0, 1.0, 0.0], [2.0, 0.0, 0.0]];

    // Two chords, one welded ring per control point.
    assert_eq!(mesh.positions.len(), 3 * 6);
    assert_eq!(mesh.indices.len(), 2 * 36);
    let chords = [control[0], control[1], control[2]];
    for (center, point) in ring_centers(&mesh).iter().zip(chords) {
        for axis in 0..3 {
            assert!(
                (center[axis] - point[axis]).abs() < 1e-6,
                "fallback ring {center:?} left its control point {point:?}"
            );
        }
    }
}

#[test]
fn nurbs_range_clips_the_evaluated_knot_domain() {
    // The range (0.5, 1.5) keeps the middle of the cubic's three spans, so the
    // evaluated domain is clipped on both sides: two spans instead of three,
    // and neither end of the result is a control point.
    let control = [
        [0.0f32, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [2.0, 1.5, 0.0],
        [3.0, 0.5, 0.0],
        [4.0, 1.0, 0.0],
        [5.0, 0.0, 0.0],
    ];
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let trimmed = open_scene(
        &dir,
        "cubic_trimmed.usda",
        &clamped_cubic_scene("double2[] ranges = [(0.5, 1.5)]"),
    );
    let full = open_scene(&dir, "cubic_full.usda", &clamped_cubic_scene(""));

    let clipped = ring_centers(
        &tessellate(&trimmed, "/Scene/Cubic").expect("trimmed cubic should tessellate"),
    );
    let untrimmed =
        ring_centers(&tessellate(&full, "/Scene/Cubic").expect("full cubic should tessellate"));

    // Two clipped spans at 8 samples: 17 evaluated points, 17 welded rings
    // (the untrimmed curve keeps its three spans and 25 rings).
    assert_eq!(untrimmed.len(), 25);
    assert_eq!(
        clipped.len(),
        2 * 8 + 1,
        "the range must clip the sampled spans, got {}",
        clipped.len()
    );
    // u = 0.5 and u = 1.5 are interior parameters: the samples no longer
    // interpolate the outer control points.
    for (center, point) in [(clipped[0], control[0]), (clipped[16], control[5])] {
        let delta = [
            center[0] - point[0],
            center[1] - point[1],
            center[2] - point[2],
        ];
        let distance = delta.iter().map(|value| value * value).sum::<f32>().sqrt();
        assert!(
            distance > 0.1,
            "a trimmed curve must not start or end on a control point, got {center:?} vs {point:?}"
        );
    }
}

#[test]
fn nurbs_without_order_or_knots_keeps_the_control_polygon() {
    // A NurbsCurves prim that authors only points and counts cannot be
    // evaluated: it must render its chords, not fail the prim.
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let stage = open_scene(
        &dir,
        "no_knots.usda",
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def NurbsCurves \"Plain\"\n{\n",
            "        int[] curveVertexCounts = [3]\n",
            "        point3f[] points = [(0, 0, 0), (1, 1, 0), (2, 0, 0)]\n",
            "        float[] widths = [0.04]\n",
            "    }\n",
            "}\n",
        ),
    );

    let mesh = tessellate(&stage, "/Scene/Plain").expect("a nurbs prim without order must render");
    let control = [[0.0f32, 0.0, 0.0], [1.0, 1.0, 0.0], [2.0, 0.0, 0.0]];

    assert_eq!(mesh.positions.len(), 3 * 6);
    assert_eq!(mesh.indices.len(), 2 * 36);
    let chords = [control[0], control[1], control[2]];
    for (center, point) in ring_centers(&mesh).iter().zip(chords) {
        for axis in 0..3 {
            assert!(
                (center[axis] - point[axis]).abs() < 1e-6,
                "fallback ring {center:?} left its control point {point:?}"
            );
        }
    }
}

#[test]
fn nurbs_with_mismatched_point_weights_keeps_the_control_polygon() {
    // Two weights for three points cannot be mapped onto the curve, so the
    // weights have no meaning: the prim keeps its chords.
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let stage = open_scene(
        &dir,
        "short_weights.usda",
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def NurbsCurves \"Weighted\"\n{\n",
            "        int[] curveVertexCounts = [3]\n",
            "        point3f[] points = [(0, 0, 0), (1, 1, 0), (2, 0, 0)]\n",
            "        int[] order = [3]\n",
            "        double[] knots = [0, 0, 0, 1, 1, 1]\n",
            "        double[] pointWeights = [1, 1]\n",
            "        float[] widths = [0.04]\n",
            "    }\n",
            "}\n",
        ),
    );

    let mesh = tessellate(&stage, "/Scene/Weighted").expect("a misweighted nurbs prim must render");
    let control = [[0.0f32, 0.0, 0.0], [1.0, 1.0, 0.0], [2.0, 0.0, 0.0]];

    assert_eq!(mesh.positions.len(), 3 * 6);
    assert_eq!(mesh.indices.len(), 2 * 36);
    let chords = [control[0], control[1], control[2]];
    for (center, point) in ring_centers(&mesh).iter().zip(chords) {
        for axis in 0..3 {
            assert!(
                (center[axis] - point[axis]).abs() < 1e-6,
                "fallback ring {center:?} left its control point {point:?}"
            );
        }
    }
}

#[test]
fn missing_order_entry_affects_only_its_own_curve() {
    // Two quadratic curves share the order array, which authors one entry.
    // The second curve must default to a coherent order so it still reads its
    // own knots instead of desyncing the shared knot cursor.
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let stage = open_scene(
        &dir,
        "one_order.usda",
        concat!(
            "#usda 1.0\n\n",
            "def Xform \"Scene\"\n{\n",
            "    def NurbsCurves \"Pair\"\n{\n",
            "        int[] curveVertexCounts = [3, 3]\n",
            "        point3f[] points = [(0, 0, 0), (1, 1, 0), (2, 0, 0), (3, 0, 0), (4, 1, 0), (5, 0, 0)]\n",
            "        int[] order = [3]\n",
            "        double[] knots = [0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1]\n",
            "        float[] widths = [0.04]\n",
            "    }\n",
            "}\n",
        ),
    );

    let mesh = tessellate(&stage, "/Scene/Pair").expect("the prim must tessellate");

    // Both curves evaluate to 9 samples (9 welded rings each) because the
    // defaulted order keeps the knot cursor aligned.
    assert_eq!(
        ring_centers(&mesh).len(),
        18,
        "the second curve must not fall back to its chord"
    );
}

#[test]
fn nurbs_with_more_spans_than_the_sample_cap_keeps_the_control_polygon() {
    // A 5000-point cubic curve has 4997 knot spans: more than the 4096 sample
    // cap, and the per-span floor of one sample lets the tube grow with the
    // span count (a 100k-span prim would ship 600k vertices). The cap bounds
    // the whole curve, so the chords are the fallback.
    let points = (0..5000)
        .map(|i| {
            // Alternating height: an interior control point is off any smooth
            // curve, so finding one in the tube proves the fallback ran.
            let height = if i % 2 == 0 { 0 } else { 10 };
            format!("({i}, {height}, 0)")
        })
        .collect::<Vec<_>>()
        .join(", ");
    // len(knots) == len(points) + degree + 1 for a cubic (order 4) curve.
    let knots = (0..=5003)
        .map(|knot| knot.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let stage = open_scene(
        &dir,
        "huge_spans.usda",
        &format!(
            concat!(
                "#usda 1.0\n\ndef Xform \"Scene\"\n{{\n",
                "    def NurbsCurves \"Huge\"\n{{\n",
                "        int[] curveVertexCounts = [5000]\n",
                "        point3f[] points = [{}]\n",
                "        int[] order = [4]\n",
                "        double[] knots = [{}]\n",
                "        float[] widths = [0.04]\n",
                "    }}\n}}\n",
            ),
            points, knots,
        ),
    );

    let mesh = tessellate(&stage, "/Scene/Huge").expect("an over-capped nurbs prim must render");
    let centers = ring_centers(&mesh);

    assert_eq!(
        centers.len(),
        5000,
        "the control polygon's chords, not samples"
    );
    // f32 keeps ~7 digits: the 1001st point survives to within 1e-4.
    assert!(
        centers
            .iter()
            .any(|center| (center[0] - 1001.0).abs() < 1e-2 && (center[1] - 10.0).abs() < 1e-2),
        "an interior control point in the tube proves the fallback"
    );
}

#[test]
fn cube_uses_size_and_spans_its_bounds() {
    let (stage, _info) = open_stage(&fixture("gprims.usda")).expect("gprims stage should open");

    let cube = tessellate(&stage, "/World/Box").expect("Box should tessellate");

    assert_eq!(cube.positions.len(), 24, "six quads, four vertices each");
    assert_eq!(cube.indices.len(), 36, "six quads, two triangles each");
    let extent = |axis: usize| {
        let values: Vec<f32> = cube.positions.iter().map(|p| p[axis]).collect();
        (
            values.iter().cloned().fold(f32::MAX, f32::min),
            values.iter().cloned().fold(f32::MIN, f32::max),
        )
    };
    assert_eq!(extent(0), (-2.0, 2.0), "size 4 spans +-2 on every axis");
    assert_eq!(extent(1), (-2.0, 2.0));
    assert_eq!(extent(2), (-2.0, 2.0));
    assert_eq!(
        cube.colors,
        Some(vec![[1.0, 0.0, 0.0]; 24]),
        "constant displayColor replicates"
    );
}

#[test]
fn cube_with_a_zero_size_falls_back_to_the_schema_default() {
    let (stage, _info) = open_stage(&fixture("gprims.usda")).expect("gprims stage should open");

    let cube = tessellate(&stage, "/World/ZeroBox").expect("ZeroBox should tessellate");

    assert!(cube
        .positions
        .iter()
        .all(|p| p.iter().all(|v| v.is_finite())));
    let widest = cube
        .positions
        .iter()
        .map(|p| p[0].abs())
        .fold(0.0_f32, f32::max);
    assert_eq!(widest, 1.0, "schema default size is 2.0");
}

fn count_geometry(nodes: &[RenderNode]) -> usize {
    nodes
        .iter()
        .map(|n| usize::from(n.has_geometry) + count_geometry(&n.children))
        .sum()
}
