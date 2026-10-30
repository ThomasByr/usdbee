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
fn non_geometry_prim_tessellates_to_none() {
    let (stage, _info) = open_stage(&fixture("basic.usda")).expect("basic stage should open");

    let world = prim(&stage, "/World").expect("World should resolve");
    let none = tessellate_prim(&world, Some(1.0)).expect("xform must not fail");
    assert!(none.is_none(), "an Xform is not geometry");
}
