// Phase 2, Task 4: the render manifest walk (purpose filtering, visibility
// inheritance, PointInstancer prototype children, material bindings) and the
// synthetic `__proto_<i>` path rewrite in the geometry/material arms.

use std::path::PathBuf;
use std::sync::mpsc;

use openusd::gf;

use usdbee_lib::stage::{
    open_stage, request_geometry_data, request_material_data, serialize_render_manifest,
    spawn_stage_owner, RenderNode, StageRequest, StageState,
};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn manifest() -> Vec<RenderNode> {
    let (stage, info) = open_stage(&fixture("purpose_scene.usda")).expect("stage should open");
    assert!(
        info.composition_errors.is_empty(),
        "composition errors: {:?}",
        info.composition_errors
    );
    serialize_render_manifest(&stage, None).expect("manifest should serialize")
}

fn find<'a>(nodes: &'a [RenderNode], path: &str) -> Option<&'a RenderNode> {
    nodes
        .iter()
        .find(|n| n.path == path)
        .or_else(|| nodes.iter().find_map(|n| find(&n.children, path)))
}

fn expect<'a>(nodes: &'a [RenderNode], path: &str) -> &'a RenderNode {
    find(nodes, path).unwrap_or_else(|| panic!("expected prim {} in manifest", path))
}

fn assert_absent(nodes: &[RenderNode], path: &str) {
    assert!(
        find(nodes, path).is_none(),
        "{} must not be in the manifest",
        path
    );
}

fn assert_matrix_close(expected: &[f64; 16], actual: &[f64; 16]) {
    for (i, (e, a)) in expected.iter().zip(actual).enumerate() {
        assert!(
            (e - a).abs() < 1e-9,
            "matrix element {i}: expected {e}, got {a}"
        );
    }
}

fn open_via_owner(state: &StageState, name: &str) {
    let (reply_tx, reply_rx) = mpsc::channel();
    state
        .sender
        .send(StageRequest::Open {
            path: fixture(name),
            reply: reply_tx,
        })
        .expect("stage owner should accept an open request");
    reply_rx
        .recv()
        .expect("stage owner should reply")
        .expect("stage should open");
}

#[test]
fn manifest_descends_through_excluded_prototype_roots() {
    // purpose_instancer.usda: the prototype root authors purpose proxy; its
    // render-purpose Mesh child must still land under the synthetic node,
    // with a proxy child of its own staying excluded.
    let (stage, info) = open_stage(&fixture("purpose_instancer.usda")).expect("stage should open");
    assert!(
        info.composition_errors.is_empty(),
        "composition errors: {:?}",
        info.composition_errors
    );
    let nodes = serialize_render_manifest(&stage, None).expect("manifest should serialize");

    // The excluded root itself must not carry drawable geometry, but the
    // synthetic node survives with its 3 instance matrices.
    let prototype = expect(&nodes, "/World/PurposeInstancer/__proto_0");
    assert_eq!(prototype.type_name, "Xform");
    assert!(
        !prototype.has_geometry,
        "proxy prototype root must not render itself"
    );
    assert_eq!(prototype.instances.len(), 3);

    let shape = expect(&nodes, "/World/PurposeInstancer/__proto_0/Shape");
    assert_eq!(shape.type_name, "Mesh");
    assert!(shape.has_geometry);
    assert!(shape.visible);

    assert_absent(&nodes, "/World/PurposeInstancer/__proto_0/ProxyChild");

    // Zero-instance prototypes of the excluded root emit nothing.
    assert_absent(&nodes, "/World/EmptyPurposeInstancer/__proto_0");
}

#[test]
fn manifest_excludes_proxy_and_guide_purpose_prims() {
    let nodes = manifest();

    assert_absent(&nodes, "/World/ProxyOnly");
    assert_absent(&nodes, "/World/GuideOnly");

    let default_cube = expect(&nodes, "/World/DefaultCube");
    assert_eq!(default_cube.type_name, "Mesh");
    assert!(default_cube.has_geometry);
    assert!(default_cube.visible);
    assert_eq!(default_cube.material, None);
}

#[test]
fn manifest_visits_default_purpose_below_excluded_parent() {
    let nodes = manifest();

    assert_absent(&nodes, "/World/ProxyParent");
    let child = expect(&nodes, "/World/ProxyParent/DefaultChild");
    assert!(child.has_geometry);
}

#[test]
fn broken_material_binding_only_drops_that_material() {
    let nodes = manifest();

    let broken = expect(&nodes, "/World/BrokenBinding");
    assert!(broken.has_geometry);
    assert_eq!(broken.material, None);
    assert!(expect(&nodes, "/World/DefaultCube").has_geometry);
}

#[test]
fn manifest_pins_visibility_inheritance() {
    let nodes = manifest();

    // The invisible prim itself is composed with visible=false.
    let hidden = expect(&nodes, "/World/Hidden");
    assert!(!hidden.visible, "authored invisible must clear visible");

    // USD semantics pinned: a child inherits the ancestor's invisible
    // unless it re-authors visibility, so the render-purpose child of an
    // invisible prim is also invisible by inheritance.
    let hidden_render = expect(&nodes, "/World/Hidden/HiddenRender");
    assert_eq!(
        hidden_render.material,
        Some("/World/Looks/Blue".to_string())
    );
    assert!(
        !hidden_render.visible,
        "a child without its own visibility opinion inherits invisible"
    );

    // USD semantics pinned: overall `visibility` inherits down and a
    // descendant CANNOT unhide itself — re-authoring `inherited` (or any
    // other token) leaves the walk running to the invisible ancestor
    // (openusd ImageableExt::compute_visibility mirrors C++ here; its own
    // `unknown_token_walks` doc-test pins the same). Only the per-purpose
    // visibilities (VisibilityAPI) allow descendant overrides.
    let revealed = expect(&nodes, "/World/Hidden/HiddenRevealed");
    assert!(
        !revealed.visible,
        "overall visibility cannot be re-authored visible"
    );
}

#[test]
fn manifest_point_instancer_serializes_prototype_children() {
    let nodes = manifest();

    let instancer = expect(&nodes, "/World/Instancer");
    assert_eq!(instancer.type_name, "PointInstancer");
    assert!(!instancer.has_geometry);
    assert!(
        instancer.instances.is_empty(),
        "instance matrices live on prototype children, not the instancer"
    );
    assert_eq!(instancer.transform[12], 100.0, "instancer local translate");

    assert_eq!(instancer.children.len(), 2, "one child per prototype");
    let cube = expect(&nodes, "/World/Instancer/__proto_0");
    assert_eq!(cube.type_name, "Mesh");
    assert!(cube.has_geometry);
    assert_eq!(cube.material, Some("/World/Looks/Blue".to_string()));
    assert!(
        cube.transform
            .iter()
            .zip(gf::Matrix4d::IDENTITY.0.iter())
            .all(|(a, b)| (a - b).abs() < 1e-9),
        "prototype children carry identity transforms"
    );

    // protoIndices = [0, 1, 0, 1]: two instances per prototype.
    assert_eq!(cube.instances.len(), 2);
    let sphere = expect(&nodes, "/World/Instancer/__proto_1");
    assert_eq!(sphere.type_name, "Mesh");
    assert!(sphere.has_geometry);
    assert_eq!(sphere.material, None);
    assert_eq!(sphere.instances.len(), 2);
}

#[test]
fn manifest_instance_transforms_compose_proto_xform_then_srt() {
    let nodes = manifest();

    // Instance 0 uses CubeProto, whose local translate is (0, 0, -2); with
    // positions[0] = (1, 2, 3) and identity orientation/scale the instance
    // matrix in the instancer's space is a pure translate to (1, 2, 1).
    let cube = expect(&nodes, "/World/Instancer/__proto_0");
    assert_matrix_close(
        &[
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 2.0, 1.0, 1.0,
        ],
        &cube.instances[0],
    );

    // Instance 1 uses SphereProto (no local xform): S(2,1,1) * Rz(180deg) *
    // T(1,0,0) in the row-vector convention, S applied most locally.
    let sphere = expect(&nodes, "/World/Instancer/__proto_1");
    assert_matrix_close(
        &[
            -2.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0,
        ],
        &sphere.instances[0],
    );
}

#[test]
fn geometry_and_material_arms_resolve_synthetic_prototype_paths() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "purpose_scene.usda");

    let synthetic = request_geometry_data(&state.sender, "/World/Instancer/__proto_0", None)
        .expect("synthetic prototype path should resolve");
    let direct = request_geometry_data(&state.sender, "/World/Instancer/CubeProto", None)
        .expect("prototype prim should tessellate");
    assert_eq!(synthetic, direct);

    let material = request_material_data(&state.sender, "/World/Instancer/__proto_0")
        .expect("prototype material should resolve");
    assert_eq!(material.name, "Blue");
}

#[test]
fn nested_prototype_geometry_uses_the_real_prim() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "purpose_scene.usda");

    let synthetic =
        request_geometry_data(&state.sender, "/World/GroupInstancer/__proto_0/Shape", None)
            .expect("nested synthetic prototype path should resolve");
    let direct = request_geometry_data(
        &state.sender,
        "/World/GroupInstancer/GroupProto/Shape",
        None,
    )
    .expect("real prototype child should tessellate");
    assert_eq!(synthetic, direct);
}

#[test]
fn native_instance_geometry_uses_the_shared_prototype_prim() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "instanced.usda");
    let (stage, _) = open_stage(&fixture("instanced.usda")).expect("stage should open");
    let prototype = stage.prototypes().expect("prototype discovery")[0].clone();
    let direct_path = prototype
        .append_path("WheelMesh")
        .expect("prototype mesh path")
        .to_string();

    let instance = request_geometry_data(&state.sender, "/Scene/WheelA/WheelMesh", None)
        .expect("instance proxy path should resolve");
    let direct = request_geometry_data(&state.sender, &direct_path, None)
        .expect("shared prototype mesh should tessellate");
    assert_eq!(instance, direct);
}

#[test]
fn out_of_range_prototype_index_is_a_readable_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "purpose_scene.usda");

    let error = request_geometry_data(&state.sender, "/World/Instancer/__proto_5", None)
        .expect_err("only 2 prototypes are authored");
    assert!(error.contains("prototype"), "got: {}", error);

    // A synthetic path under a non-instancer prim never resolves.
    let error = request_geometry_data(&state.sender, "/World/DefaultCube/__proto_0", None)
        .expect_err("a Mesh is not an instancer");
    assert!(
        error.contains("PointInstancer") || error.contains("prototype"),
        "got: {}",
        error
    );
}

#[test]
fn manifest_expands_xform_prototype_renderable_subtree() {
    let nodes = manifest();

    let prototype = expect(&nodes, "/World/GroupInstancer/__proto_0");
    assert_eq!(prototype.type_name, "Xform");
    assert!(!prototype.has_geometry);
    assert_eq!(prototype.instances.len(), 1);
    let shape = expect(&nodes, "/World/GroupInstancer/__proto_0/Shape");
    assert_eq!(shape.type_name, "Mesh");
    assert!(shape.has_geometry);
}

#[test]
fn manifest_omits_prototypes_without_instances() {
    let nodes = manifest();

    let instancer = expect(&nodes, "/World/EmptyInstancer");
    assert!(instancer.children.is_empty());
    assert_absent(&nodes, "/World/EmptyInstancer/__proto_0");
}

#[test]
fn manifest_filters_invisible_instance_ids_at_the_queried_time() {
    let (stage, _) = open_stage(&fixture("purpose_scene.usda")).expect("stage should open");

    let at_one = serialize_render_manifest(&stage, Some(1.0)).expect("manifest at time 1");
    let visible = expect(&at_one, "/World/VisibilityInstancer/__proto_0");
    assert_eq!(visible.instances.len(), 1);
    assert_eq!(visible.instances[0][12], 0.0);

    let at_two = serialize_render_manifest(&stage, Some(2.0)).expect("manifest at time 2");
    assert_absent(&at_two, "/World/VisibilityInstancer/__proto_0");
}

#[test]
fn manifest_expands_native_instance_prototype_children() {
    let (stage, info) = open_stage(&fixture("instanced.usda")).expect("stage should open");
    assert!(info.composition_errors.is_empty());
    let nodes = serialize_render_manifest(&stage, None).expect("manifest should serialize");

    for instance in ["/Scene/WheelA", "/Scene/WheelB"] {
        let mesh = expect(&nodes, &format!("{instance}/WheelMesh"));
        assert_eq!(mesh.type_name, "Mesh");
        assert!(mesh.has_geometry);
    }
}

#[test]
fn manifest_counts_curves_and_points_as_geometry() {
    let (stage, info) = open_stage(&fixture("curves_points.usda")).expect("stage should open");
    assert!(
        info.composition_errors.is_empty(),
        "composition errors: {:?}",
        info.composition_errors
    );
    let nodes = serialize_render_manifest(&stage, None).expect("manifest should serialize");

    for (path, name, type_name) in [
        ("/Scene/Stroke", "Stroke", "BasisCurves"),
        ("/Scene/Dot", "Dot", "BasisCurves"),
        ("/Scene/Dust", "Dust", "Points"),
    ] {
        let node = expect(&nodes, path);
        assert_eq!(node.type_name, type_name);
        assert!(node.has_geometry, "{name} renders geometry");
        assert_eq!(node.material, None, "no binding authored on {name}");
    }
}
