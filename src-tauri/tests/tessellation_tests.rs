use std::path::PathBuf;

use usdbee_lib::stage::open_stage;
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

    // Controller-pinned counts: per curve of n=4 points, segments = 3, and
    // per segment a 6-sided ring pair (12 vertices, rings duplicated per
    // segment, not shared between neighbors) of 6 quads = 36 indices.
    assert_eq!(mesh.positions.len(), 3 * 12);
    assert_eq!(mesh.indices.len(), 3 * 36);
    assert_eq!(mesh.normals.as_ref().map(|n| n.len()), Some(36));

    // Curves render as tubes with no authored primvars: uvs/colors stay
    // unset (the bound material color applies, controller resolution).
    assert!(mesh.uvs.is_none());
    assert!(mesh.colors.is_none());

    // Winding pinned: first quad of segment 0, and the last indices close
    // the tube back on k=0.
    assert_eq!(&mesh.indices[0..6], &[0u32, 1, 7, 0, 7, 6]);
    assert_eq!(&mesh.indices[105..108], &[29u32, 30, 35]);
}

#[test]
fn curve_ring_vertices_sit_at_radius_from_their_segment_endpoints() {
    let (stage, _info) = tessellate_stage("curves_points.usda");

    let mesh = tessellate(&stage, "/Scene/Stroke").expect("curve should tessellate");

    let radius = 0.1f32;
    let centers = [
        [0.0f32, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [2.0, 1.0, 0.0],
    ];
    for (vertex, position) in mesh.positions.iter().enumerate() {
        let segment = vertex / 12;
        let within = vertex % 12;
        // Ring A centers the segment's start point, ring B its end point.
        let center = centers[segment + within / 6];
        let distance_sq = (position[0] - center[0]).powi(2)
            + (position[1] - center[1]).powi(2)
            + (position[2] - center[2]).powi(2);
        assert!(
            (distance_sq - radius * radius).abs() < 1e-6,
            "vertex {vertex} at {position:?} is not at radius from center {center:?}"
        );
    }
}

#[test]
fn bent_curve_second_ring_is_perpendicular_to_its_own_tangent() {
    let (stage, _info) = tessellate_stage("curves_points.usda");
    let mesh = tessellate(&stage, "/Scene/Stroke").expect("curve should tessellate");

    // Segment 1 runs from (1,0,0) to (1,1,0): its tangent is +Y, unlike
    // segment 0's +X. Every radial vector in both of its rings must be
    // perpendicular to +Y.
    for (offset, position) in mesh.positions[12..24].iter().enumerate() {
        let center = if offset < 6 {
            [1.0, 0.0, 0.0]
        } else {
            [1.0, 1.0, 0.0]
        };
        let radial_y = position[1] - center[1];
        assert!(
            radial_y.abs() < 1e-6,
            "ring vertex {:?} uses the wrong frame",
            position
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
