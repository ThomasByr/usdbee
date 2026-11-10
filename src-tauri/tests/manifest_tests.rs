// Phase 2, Task 4: the render manifest walk (purpose filtering, visibility
// inheritance, PointInstancer prototype children, material bindings) and the
// synthetic `__proto_<i>` path rewrite in the geometry/material arms.
//
// Phase 2.5 Task 2 adds the two cache pins at the bottom: the owner-thread
// manifest cache must serve repeated calls without freezing per-time data.

use std::path::PathBuf;

mod common;

use common::spawn_stage_owner;
use openusd::gf;

use usdbee_lib::stage::{
    open_stage, request_animated_manifest, request_animated_pose, request_animated_pose_batch,
    request_geometry_batch, request_geometry_data, request_material_data, request_redo,
    request_scene_manifest, request_set_attribute_value, request_time_codes, request_undo,
    serialize_render_manifest, RenderNode,
};
use usdbee_lib::values::{local_transform, ValuePayload};

fn open_fixture_manifest(name: &str, time: Option<f64>) -> Vec<RenderNode> {
    let (stage, info) = open_stage(&fixture(name)).expect("stage should open");
    assert!(
        info.composition_errors.is_empty(),
        "composition errors: {:?}",
        info.composition_errors
    );
    serialize_render_manifest(&stage, time).expect("manifest should serialize")
}

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

fn payload(r#type: &str, data: serde_json::Value) -> ValuePayload {
    ValuePayload {
        r#type: r#type.to_string(),
        data,
        truncated: None,
        count: None,
    }
}

fn assert_matrix_close(expected: &[f64; 16], actual: &[f64; 16]) {
    for (i, (e, a)) in expected.iter().zip(actual).enumerate() {
        assert!(
            (e - a).abs() < 1e-9,
            "matrix element {i}: expected {e}, got {a}"
        );
    }
}

fn open_via_owner(state: &common::TestOwner, name: &str) {
    state.open(&fixture(name));
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
fn manifest_resamples_prototype_visibility_under_a_sampled_instancer() {
    // A PointInstancer prototype is a real child prim, so the instancer's own
    // sampled visibility inherits into the prototype subtree. Those nodes'
    // computed visibility is time-dependent even though nothing inside the
    // prototype chain samples, so the skeleton's static visibility cache must
    // not stand in for the per-call read.
    let at_one = open_fixture_manifest("instancer_vis_parent.usda", Some(1.0));
    assert!(
        !expect(&at_one, "/Scene/Inst/__proto_0").visible,
        "prototype root inherits the instancer's invisible at t=1"
    );
    assert!(
        !expect(&at_one, "/Scene/Inst/__proto_0/Child").visible,
        "prototype child inherits the instancer's invisible at t=1"
    );

    let at_two = open_fixture_manifest("instancer_vis_parent.usda", Some(2.0));
    assert!(expect(&at_two, "/Scene/Inst/__proto_0").visible);
    assert!(expect(&at_two, "/Scene/Inst/__proto_0/Child").visible);
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

    let synthetic = request_geometry_data(&state.sender(), "/World/Instancer/__proto_0", None)
        .expect("synthetic prototype path should resolve");
    let direct = request_geometry_data(&state.sender(), "/World/Instancer/CubeProto", None)
        .expect("prototype prim should tessellate");
    assert_eq!(synthetic, direct);

    let material = request_material_data(&state.sender(), "/World/Instancer/__proto_0")
        .expect("prototype material should resolve");
    assert_eq!(material.name, "Blue");
}

#[test]
fn nested_prototype_geometry_uses_the_real_prim() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "purpose_scene.usda");

    let synthetic = request_geometry_data(
        &state.sender(),
        "/World/GroupInstancer/__proto_0/Shape",
        None,
    )
    .expect("nested synthetic prototype path should resolve");
    let direct = request_geometry_data(
        &state.sender(),
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

    let instance = request_geometry_data(&state.sender(), "/Scene/WheelA/WheelMesh", None)
        .expect("instance proxy path should resolve");
    let direct = request_geometry_data(&state.sender(), &direct_path, None)
        .expect("shared prototype mesh should tessellate");
    assert_eq!(instance, direct);
}

#[test]
fn out_of_range_prototype_index_is_a_readable_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "purpose_scene.usda");

    let error = request_geometry_data(&state.sender(), "/World/Instancer/__proto_5", None)
        .expect_err("only 2 prototypes are authored");
    assert!(error.contains("prototype"), "got: {}", error);

    // A synthetic path under a non-instancer prim never resolves.
    let error = request_geometry_data(&state.sender(), "/World/DefaultCube/__proto_0", None)
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
fn native_instances_of_one_prototype_expand_independently() {
    // native_instances.usda: two instances share one prototype; the first
    // sits under a translated mover, the second under nothing. The shared
    // prototype traversal must not leak one instance's transform or
    // animated state into the other (memoization correctness pin).
    let nodes = open_fixture_manifest("native_instances.usda", Some(0.0));

    let mover = expect(&nodes, "/Scene/Mover");
    assert_eq!(mover.transform[12], 1.0, "mover translate");
    assert!(mover.animated, "sampled xform animates the subtree");
    let in_motion = expect(&nodes, "/Scene/Mover/InMotion");
    assert!(
        in_motion.children.len() >= 2,
        "instance expands the prototype"
    );
    let moving_mesh = expect(&nodes, "/Scene/Mover/InMotion/WheelMesh");
    assert_eq!(moving_mesh.type_name, "Mesh");
    assert!(moving_mesh.has_geometry);
    assert!(
        moving_mesh.animated,
        "descendants of an instance under a sampled xform animate"
    );

    let at_rest = expect(&nodes, "/Scene/AtRest");
    assert_eq!(at_rest.transform[12], 0.0, "its own translate");
    assert_eq!(at_rest.transform[13], 5.0);
    let resting_mesh = expect(&nodes, "/Scene/AtRest/WheelMesh");
    assert!(resting_mesh.has_geometry);
    assert!(
        !resting_mesh.animated,
        "the sharing instance never inherits the other tree's ancestor moves"
    );
    assert_eq!(moving_mesh.transform, resting_mesh.transform);
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

// Task 2 cache pins: manifest calls routed through the stage owner exercise
// the per-stage-open skeleton cache (warm on every call after the first).

fn assert_static_skeleton_equal(expected: &[RenderNode], actual: &[RenderNode]) {
    assert_eq!(
        expected.len(),
        actual.len(),
        "time-independent node count changed between calls"
    );
    for (expected, actual) in expected.iter().zip(actual) {
        assert_eq!(expected.path, actual.path);
        assert_eq!(expected.name, actual.name);
        assert_eq!(expected.type_name, actual.type_name);
        assert_eq!(expected.has_geometry, actual.has_geometry);
        assert_eq!(expected.animated, actual.animated);
        assert_eq!(expected.geometry_animated, actual.geometry_animated);
        assert_eq!(expected.material, actual.material);
        assert_static_skeleton_equal(&expected.children, &actual.children);
    }
}

fn assert_manifest_json_equal(expected: &[RenderNode], actual: &[RenderNode]) {
    let expected = serde_json::to_vec(expected).expect("manifest should serialize");
    let actual = serde_json::to_vec(actual).expect("manifest should serialize");
    assert_eq!(expected, actual, "manifest JSON must be byte-identical");
}

#[test]
fn cached_manifest_calls_stay_structure_equal_and_resample_the_queried_time() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");

    // Cold (cache build), warm at another time, warm back at the first time.
    let at_zero = request_scene_manifest(&state.sender(), Some(0.0))
        .expect("manifest at t=0 should serialize");
    let at_ten = request_scene_manifest(&state.sender(), Some(10.0))
        .expect("manifest at t=10 should serialize");
    let back_to_zero = request_scene_manifest(&state.sender(), Some(0.0))
        .expect("manifest back at t=0 should serialize");

    // The time-independent fields are the same on every call: a frozen or
    // half-frozen cache breaks either comparison.
    assert_static_skeleton_equal(&at_zero, &at_ten);
    assert_static_skeleton_equal(&at_zero, &back_to_zero);

    // Warm calls sample their own time: Pulse's translate interpolates
    // between the t=1 and t=24 samples.
    let pulse_at_zero = expect(&at_zero, "/Scene/Pulse").transform[12];
    let pulse_at_ten = expect(&at_ten, "/Scene/Pulse").transform[12];
    assert_ne!(
        pulse_at_zero, pulse_at_ten,
        "the warm call must carry its own requested time"
    );

    // A later call at the first time is byte-equal to the first: the t=10
    // call must not bleed into the cache.
    assert_manifest_json_equal(&at_zero, &back_to_zero);
}

#[test]
fn cached_manifest_calls_do_not_freeze_time_dependent_structure() {
    // invisibleIds time samples hide every instance at t=2, so the synthetic
    // prototype child exists at t=1, is gone at t=2, and is back at t=1: a
    // cache that freezes the walk's structure at its first time is wrong.
    let state = spawn_stage_owner();
    open_via_owner(&state, "purpose_scene.usda");

    let at_one = request_scene_manifest(&state.sender(), Some(1.0))
        .expect("manifest at t=1 should serialize");
    expect(&at_one, "/World/VisibilityInstancer/__proto_0");

    let at_two = request_scene_manifest(&state.sender(), Some(2.0))
        .expect("manifest at t=2 should serialize");
    assert_absent(&at_two, "/World/VisibilityInstancer/__proto_0");

    let back_to_one = request_scene_manifest(&state.sender(), Some(1.0))
        .expect("manifest back at t=1 should serialize");
    assert_manifest_json_equal(&at_one, &back_to_one);
}

#[test]
fn warm_manifest_resamples_sampled_visibility_per_time() {
    // Owner-routed pin (Task 2 review follow-up): a prim's overall
    // `visibility` field with time samples flips the manifest's `visible`
    // flag per queried time. A skeleton cache that hoisted visibility
    // (the one per-time imageable query Task 1 ruled must stay per-call)
    // breaks the false -> true -> false sequence below.
    let state = spawn_stage_owner();
    open_via_owner(&state, "sampled_visibility.usda");

    let at_one = request_scene_manifest(&state.sender(), Some(1.0))
        .expect("manifest at t=1 should serialize");
    assert!(
        !expect(&at_one, "/Scene/Toggle").visible,
        "invisible at t=1"
    );

    let at_two = request_scene_manifest(&state.sender(), Some(2.0))
        .expect("manifest at t=2 should serialize");
    assert!(expect(&at_two, "/Scene/Toggle").visible, "visible at t=2");

    let back_to_one = request_scene_manifest(&state.sender(), Some(1.0))
        .expect("manifest back at t=1 should serialize");
    assert!(
        !expect(&back_to_one, "/Scene/Toggle").visible,
        "re-samples at t=1"
    );
}

#[test]
fn warm_manifest_uses_identity_for_unsupported_xform_ops() {
    // xforms.usda: /World/Unsupported authors `xformOp:flip`, an op the
    // evaluator refuses, so `local_transform` answers None and the skeleton
    // caches no static transform. At the walk's use site that None becomes the
    // identity matrix, on the cold and on the warm call alike: an unsupported
    // chain never yields a partial or wrong matrix.
    let state = spawn_stage_owner();
    open_via_owner(&state, "xforms.usda");

    let identity = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];
    let cold = request_scene_manifest(&state.sender(), None).expect("manifest should serialize");
    let warm =
        request_scene_manifest(&state.sender(), Some(1.0)).expect("manifest should serialize");
    for nodes in [&cold, &warm] {
        assert_matrix_close(&identity, &expect(nodes, "/World/Unsupported").transform);
    }

    // The parent still holds its own authored translate: the identity is the
    // child's local matrix, not a flattened world one.
    assert_eq!(expect(&cold, "/World").transform[12], 10.0);
}

#[test]
fn editing_a_static_prims_transform_and_visibility_clears_the_skeleton() {
    // xforms.usda: /World/StaticXform authors a static translate and a static
    // `visibility = "invisible"`, so both values live in the skeleton cache.
    // The edit, the undo and the redo must each drop that cache: a stale
    // skeleton serves the pre-edit values forever.
    let state = spawn_stage_owner();
    open_via_owner(&state, "xforms.usda");

    // Warm the cache and pin the authored values.
    let original =
        request_scene_manifest(&state.sender(), None).expect("manifest should serialize");
    let before = expect(&original, "/World/StaticXform").clone();
    assert_eq!(before.transform[12], 4.0, "authored translate");
    assert!(!before.visible, "authored visibility");

    // The same authoring path the editing commands use.
    request_set_attribute_value(
        &state.sender(),
        "/World/StaticXform",
        "xformOp:translate",
        &payload("double3", serde_json::json!([0, 3, 0])),
        None,
    )
    .expect("authoring the translate should succeed");
    request_set_attribute_value(
        &state.sender(),
        "/World/StaticXform",
        "visibility",
        &payload("token", serde_json::json!("inherited")),
        None,
    )
    .expect("authoring visibility should succeed");

    let edited = request_scene_manifest(&state.sender(), None).expect("manifest should serialize");
    let after = expect(&edited, "/World/StaticXform").clone();
    assert_eq!(
        after.transform[12], 0.0,
        "the new translate, not the cached one"
    );
    assert_eq!(
        after.transform[13], 3.0,
        "the new translate, not the cached one"
    );
    assert!(after.visible, "the new visibility, not the cached one");

    // One undo entry per authored attribute.
    for _ in 0..2 {
        assert!(request_undo(&state.sender()).expect("undo should succeed"));
    }
    let reverted =
        request_scene_manifest(&state.sender(), None).expect("manifest should serialize");
    let node = expect(&reverted, "/World/StaticXform");
    assert_matrix_close(&before.transform, &node.transform);
    assert_eq!(node.visible, before.visible, "undo restores the visibility");

    for _ in 0..2 {
        assert!(request_redo(&state.sender()).expect("redo should succeed"));
    }
    let redone = request_scene_manifest(&state.sender(), None).expect("manifest should serialize");
    let node = expect(&redone, "/World/StaticXform");
    assert_matrix_close(&after.transform, &node.transform);
    assert_eq!(node.visible, after.visible, "redo restores the edit");
}

// Sample-time transform memo (stage owner, beside the mesh cache): animated
// prims whose xformOps author samples are re-composed per (prim, time); the
// memo serves them across calls. These pins assert only that the memo never
// changes an answer — same-time repeats, edits, undo/redo, and an uncached
// read as the oracle.

fn flatten<'a>(nodes: &'a [RenderNode], out: &mut Vec<&'a RenderNode>) {
    for node in nodes {
        out.push(node);
        flatten(&node.children, out);
    }
}

#[test]
fn repeated_delta_manifest_at_one_time_is_identical_with_the_transform_memo() {
    // The second call at the same time must serve the memo and still return
    // byte-identical transforms and visibility...
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");

    for time in [0.0, 10.0, 17.5] {
        let first = request_animated_manifest(&state.sender(), Some(time))
            .expect("delta manifest should serialize");
        let second = request_animated_manifest(&state.sender(), Some(time))
            .expect("delta manifest should serialize");
        assert_manifest_json_equal(&first, &second);
        assert!(
            find(&first, "/Scene/Mover").is_some(),
            "the sampled prim rides the delta at {time}"
        );
    }
}

#[test]
fn memoized_sample_transforms_match_an_uncached_walk() {
    // The oracle is a second stage plus a per-prim `local_transform`: no memo,
    // no skeleton. Every transform the warm delta serves must equal it.
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");
    let (oracle, _) = open_stage(&fixture("animated.usda")).expect("stage should open");

    for time in [0.0, 1.0, 10.0, 17.5, 24.0] {
        // Cold call fills the memo, warm call must serve it.
        request_animated_manifest(&state.sender(), Some(time))
            .expect("cold delta manifest should serialize");
        let warm = request_animated_manifest(&state.sender(), Some(time))
            .expect("warm delta manifest should serialize");
        let mut nodes = Vec::new();
        flatten(&warm, &mut nodes);
        assert!(!nodes.is_empty(), "delta at {} must carry nodes", time);
        for node in nodes {
            let prim = oracle
                .prim(
                    openusd::sdf::try_into_path(node.path.as_str())
                        .expect("render path should parse"),
                )
                .expect("render path should resolve");
            let expected = local_transform(&prim, Some(time))
                .expect("local transform should compose")
                .unwrap_or(gf::Matrix4d::IDENTITY);
            assert_matrix_close(&expected.0, &node.transform);
        }
    }
}

#[test]
fn editing_a_sampled_xform_at_a_time_reaches_the_manifest() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");

    // Warm the memo at the time the edit targets.
    let warm = request_animated_manifest(&state.sender(), Some(10.0))
        .expect("delta manifest should serialize");
    assert_eq!(expect(&warm, "/Scene/Mover").transform[12], 5.0);

    request_set_attribute_value(
        &state.sender(),
        "/Scene/Mover",
        "xformOp:translate",
        &payload("double3", serde_json::json!([0, 7, 0])),
        Some(10.0),
    )
    .expect("authoring the sampled translate should succeed");

    let edited = request_animated_manifest(&state.sender(), Some(10.0))
        .expect("delta manifest should serialize");
    let node = expect(&edited, "/Scene/Mover");
    assert_eq!(node.transform[12], 0.0, "the edited sample, not the memo");
    assert_eq!(node.transform[13], 7.0, "the edited sample, not the memo");
}

#[test]
fn default_time_xform_edit_clears_every_memoized_sample() {
    // A gizmo commit on an animated prim writes at DEFAULT time and keeps the
    // skeleton warm (`warm_xform_keep`). An entry the memo already holds at a
    // sampled time must not survive it.
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");

    // Both times enter the memo.
    for time in [0.0, 10.0] {
        request_animated_manifest(&state.sender(), Some(time))
            .expect("delta manifest should serialize");
    }
    let before = request_animated_manifest(&state.sender(), Some(10.0))
        .expect("delta manifest should serialize");
    let prior = expect(&before, "/Scene/Mover").transform;

    request_set_attribute_value(
        &state.sender(),
        "/Scene/Mover",
        "xformOp:rotateXYZ",
        &payload("float3", serde_json::json!([0, 0, 90])),
        None,
    )
    .expect("creating the rotate should succeed");
    request_set_attribute_value(
        &state.sender(),
        "/Scene/Mover",
        "xformOpOrder",
        &payload(
            "token_array",
            serde_json::json!(["xformOp:translate", "xformOp:rotateXYZ"]),
        ),
        None,
    )
    .expect("authoring the order should succeed");

    let after = request_animated_manifest(&state.sender(), Some(10.0))
        .expect("delta manifest should serialize");
    let node = expect(&after, "/Scene/Mover").transform;
    assert!(
        node[0].abs() < 1e-9,
        "the 90-degree Z rotation applies: got {:?}",
        node
    );
    assert_eq!(node[12], 5.0, "the t=10 sample still drives the translate");
    assert_ne!(node, prior, "the pre-edit matrix must not be served");
}

#[test]
fn undo_and_redo_of_a_sampled_xform_edit_reach_the_manifest() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");

    let original = request_animated_manifest(&state.sender(), Some(10.0))
        .expect("delta manifest should serialize");
    let before = expect(&original, "/Scene/Mover").transform;

    request_set_attribute_value(
        &state.sender(),
        "/Scene/Mover",
        "xformOp:translate",
        &payload("double3", serde_json::json!([0, 7, 0])),
        Some(10.0),
    )
    .expect("authoring the sampled translate should succeed");
    let edited = request_animated_manifest(&state.sender(), Some(10.0))
        .expect("delta manifest should serialize");
    assert_eq!(expect(&edited, "/Scene/Mover").transform[13], 7.0);

    assert!(request_undo(&state.sender()).expect("undo should succeed"));
    let undone = request_animated_manifest(&state.sender(), Some(10.0))
        .expect("delta manifest should serialize");
    assert_matrix_close(&before, &expect(&undone, "/Scene/Mover").transform);

    assert!(request_redo(&state.sender()).expect("redo should succeed"));
    let redone = request_animated_manifest(&state.sender(), Some(10.0))
        .expect("delta manifest should serialize");
    let node = expect(&redone, "/Scene/Mover").transform;
    assert_eq!(node[12], 0.0, "redo reapplies the edit");
    assert_eq!(node[13], 7.0, "redo reapplies the edit");
}

// Merged pose (one invoke per playback step): the single response must carry
// the same delta tree and the same geometry slots as the two commands it
// replaces — otherwise a playback step would apply a different pose on the two
// paths, and a slot swapped with its neighbour would paint the wrong mesh on
// the wrong prim.
// The reference side runs the owner-thread request functions directly
// (`request_animated_manifest` + `request_geometry_batch`), the same path the
// profile probes drive; no IPC command wraps the delta manifest any more.
//
// Pose frame layout (stage.rs::frame_pose), per pose:
//   [u32 LE path count][per path: u32 LE len + utf8][pad to 4]
//   [u32 LE material count][per material: u32 LE len + utf8][pad to 4]
//   [u32 LE node count][node count x node, pre-order]
//   [geometry batch]
// and node =
//   [u32 path id][u32 first child id (0xFFFF_FFFF for a leaf)][u16 child
//   count][u8 flags (bit0 has_geometry, bit1 geometry_animated, bit2 has
//   instances, bit3 is_points, bit4 animated)][u8 visible][u32 material id
//   (0xFFFF_FFFF for none)][16 x f32 LE matrix]
//   [u32 instance count][instance count x 16 f32 LE]   // only when bit2
// The decoder below is the spec the frontend one has to match: it rebuilds the
// exact tree from first_child_id + child_count.

fn animated_geometry_paths(nodes: &[RenderNode], paths: &mut Vec<String>) {
    for node in nodes {
        if node.has_geometry && node.geometry_animated && !paths.contains(&node.path) {
            paths.push(node.path.clone());
        }
        animated_geometry_paths(&node.children, paths);
    }
}

fn align4(offset: usize) -> usize {
    offset + (4 - offset % 4) % 4
}

/// One node of a decoded pose frame, exactly as the frame carries it: no name
/// (the pose path names objects from the path), and `animated` is the raw
/// motion flag, which the pose path gates the whole drawable update on.
#[derive(Debug, Clone)]
struct PoseNode {
    path: String,
    first_child: u32,
    child_count: u16,
    has_geometry: bool,
    geometry_animated: bool,
    animated: bool,
    is_points: bool,
    visible: bool,
    material: Option<String>,
    matrix: [f32; 16],
    instances: Vec<[f32; 16]>,
}

struct DecodedPose<'a> {
    paths: Vec<String>,
    materials: Vec<String>,
    /// Pre-order, flat.
    nodes: Vec<PoseNode>,
    /// The geometry batch tail, byte for byte.
    slots: &'a [u8],
}

const POSE_LEAF: u32 = u32::MAX;
const POSE_NO_MATERIAL: u32 = u32::MAX;
const POSE_FLAG_HAS_GEOMETRY: u8 = 1 << 0;
const POSE_FLAG_GEOMETRY_ANIMATED: u8 = 1 << 1;
const POSE_FLAG_INSTANCES: u8 = 1 << 2;
const POSE_FLAG_IS_POINTS: u8 = 1 << 3;
const POSE_FLAG_ANIMATED: u8 = 1 << 4;

fn take_u32(bytes: &[u8], at: &mut usize) -> u32 {
    let value = u32::from_le_bytes(bytes[*at..*at + 4].try_into().unwrap());
    *at += 4;
    value
}

fn take_f32s<const N: usize>(bytes: &[u8], at: &mut usize) -> [f32; N] {
    let mut out = [0.0f32; N];
    for slot in out.iter_mut() {
        *slot = f32::from_le_bytes(bytes[*at..*at + 4].try_into().unwrap());
        *at += 4;
    }
    out
}

/// A merged pose frame, decoded the way the frontend must: true lengths from
/// the u32 prefixes, implicit 4-byte padding between the sections.
fn decode_pose(frame: &[u8]) -> DecodedPose<'_> {
    let mut at = 0;
    let path_count = take_u32(frame, &mut at) as usize;
    let mut paths = Vec::with_capacity(path_count);
    for _ in 0..path_count {
        let len = take_u32(frame, &mut at) as usize;
        paths.push(
            std::str::from_utf8(&frame[at..at + len])
                .expect("path must be utf8")
                .to_string(),
        );
        at += len;
    }
    at = align4(at);
    let material_count = take_u32(frame, &mut at) as usize;
    let mut materials = Vec::with_capacity(material_count);
    for _ in 0..material_count {
        let len = take_u32(frame, &mut at) as usize;
        materials.push(
            std::str::from_utf8(&frame[at..at + len])
                .expect("material binding must be utf8")
                .to_string(),
        );
        at = align4(at + len);
    }
    let node_count = take_u32(frame, &mut at) as usize;
    let mut nodes = Vec::with_capacity(node_count);
    for _ in 0..node_count {
        let path_id = take_u32(frame, &mut at) as usize;
        let first_child = take_u32(frame, &mut at);
        let child_count = u16::from_le_bytes(frame[at..at + 2].try_into().unwrap());
        at += 2;
        let flags = frame[at];
        let visible = frame[at + 1];
        at += 2;
        let material_id = take_u32(frame, &mut at) as usize;
        let matrix = take_f32s::<16>(frame, &mut at);
        let instances = if flags & POSE_FLAG_INSTANCES != 0 {
            let count = take_u32(frame, &mut at) as usize;
            (0..count)
                .map(|_| take_f32s::<16>(frame, &mut at))
                .collect()
        } else {
            Vec::new()
        };
        nodes.push(PoseNode {
            path: paths
                .get(path_id)
                .unwrap_or_else(|| panic!("node path id {path_id} out of range"))
                .clone(),
            first_child,
            child_count,
            has_geometry: flags & POSE_FLAG_HAS_GEOMETRY != 0,
            geometry_animated: flags & POSE_FLAG_GEOMETRY_ANIMATED != 0,
            animated: flags & POSE_FLAG_ANIMATED != 0,
            is_points: flags & POSE_FLAG_IS_POINTS != 0,
            material: if material_id == POSE_NO_MATERIAL as usize {
                None
            } else {
                Some(
                    materials
                        .get(material_id)
                        .unwrap_or_else(|| panic!("node material id {material_id} out of range"))
                        .clone(),
                )
            },
            visible: match visible {
                0 => false,
                1 => true,
                other => panic!("node visibility byte {other}"),
            },
            matrix,
            instances,
        });
    }
    DecodedPose {
        paths,
        materials,
        nodes,
        slots: &frame[at..],
    }
}

/// A tree rebuilt from the flat pre-order list, using first_child_id +
/// child_count exactly like the frontend decoder will.
#[derive(Debug)]
struct PoseTree {
    node: PoseNode,
    children: Vec<PoseTree>,
}

fn build_pose_node(nodes: &[PoseNode], id: usize) -> (PoseTree, usize) {
    let node = &nodes[id];
    let mut children = Vec::with_capacity(node.child_count as usize);
    let mut cursor = node.first_child as usize;
    for _ in 0..node.child_count {
        let (child, next) = build_pose_node(nodes, cursor);
        children.push(child);
        cursor = next;
    }
    if node.child_count == 0 {
        assert_eq!(
            node.first_child, POSE_LEAF,
            "leaf {} must point at no child",
            node.path
        );
    } else {
        // Pre-order: a node's children follow it directly.
        assert_eq!(
            node.first_child as usize,
            id + 1,
            "{}: first child must be the next pre-order index",
            node.path
        );
    }
    (
        PoseTree {
            node: node.clone(),
            children,
        },
        if node.child_count == 0 {
            id + 1
        } else {
            cursor
        },
    )
}

fn rebuild_pose_tree(nodes: &[PoseNode]) -> Vec<PoseTree> {
    let mut roots = Vec::new();
    let mut cursor = 0;
    while cursor < nodes.len() {
        let (tree, next) = build_pose_node(nodes, cursor);
        roots.push(tree);
        cursor = next;
    }
    roots
}

fn assert_pose_matrix(json: &[f64; 16], bin: &[f32; 16], where_: &str) {
    for (element, (exact, approx)) in json.iter().zip(bin.iter()).enumerate() {
        let approx = *approx as f64;
        let scale = exact.abs().max(approx.abs());
        assert!(
            (exact - approx).abs() <= 1e-6 * scale,
            "{where_} element {element}: json {exact} vs f32 {approx} exceeds the 1e-6 relative tolerance"
        );
    }
}

/// Deep compare of the decoded tree against the JSON delta manifest: paths,
/// tree shape, matrices (1e-6 relative), visibility, flags, material bindings
/// and instance matrices. Any field drift fails here.
fn assert_pose_matches(nodes: &[RenderNode], trees: &[PoseTree], where_: &str) {
    assert_eq!(nodes.len(), trees.len(), "{where_}: root count");
    for (node, tree) in nodes.iter().zip(trees) {
        assert_eq!(node.path, tree.node.path, "{where_}: path");
        assert_eq!(node.visible, tree.node.visible, "{}: visible", node.path);
        assert_eq!(
            node.has_geometry, tree.node.has_geometry,
            "{}: has_geometry",
            node.path
        );
        assert_eq!(
            node.geometry_animated, tree.node.geometry_animated,
            "{}: geometry_animated",
            node.path
        );
        assert_eq!(
            node.type_name == "Points",
            tree.node.is_points,
            "{}: is_points follows type_name",
            node.path
        );
        assert_eq!(node.material, tree.node.material, "{}: material", node.path);
        assert_eq!(node.animated, tree.node.animated, "{}: animated", node.path);
        // The frame drops `name`; the pose path names objects from the path.
        if node.geometry_animated {
            assert!(node.animated, "{}: geometry implies animated", node.path);
        }
        // The frame drops `animated`; the pose path only reads it next to
        // `geometry_animated`, which is the tighter condition.
        if node.geometry_animated {
            assert!(node.animated, "{}: geometry implies animated", node.path);
        }
        assert_pose_matrix(&node.transform, &tree.node.matrix, &node.path);
        assert_eq!(
            node.instances.len(),
            tree.node.instances.len(),
            "{}: instance count",
            node.path
        );
        for (instance, decoded) in node.instances.iter().zip(&tree.node.instances) {
            assert_pose_matrix(instance, decoded, &node.path);
        }
        assert_pose_matches(&node.children, &tree.children, where_);
    }
}

/// The frame's path table: every node path once, in first-visit pre-order.
fn pose_path_table(nodes: &[RenderNode], table: &mut Vec<String>) {
    for node in nodes {
        if !table.contains(&node.path) {
            table.push(node.path.clone());
        }
        pose_path_table(&node.children, table);
    }
}

/// The frame's material table: every distinct binding the frame's nodes carry
/// once, in first-visit pre-order.
fn pose_material_table(nodes: &[RenderNode], table: &mut Vec<String>) {
    for node in nodes {
        if let Some(binding) = node.material.as_ref() {
            if !table.contains(binding) {
                table.push(binding.clone());
            }
        }
        pose_material_table(&node.children, table);
    }
}

/// Edge pins for the node record: a leaf marks no child, a root list carries
/// as many roots as the manifest, and a stage whose pose is empty still frames
/// a readable (empty) table.
#[test]
fn pose_frame_pins_the_node_record_edges() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "skinned.usda");
    let nodes = request_animated_manifest(&state.sender(), Some(1.0))
        .expect("delta manifest should serialize");
    let frame = request_animated_pose(&state.sender(), Some(1.0)).expect("pose should serialize");
    let decoded = decode_pose(&frame);
    let trees = rebuild_pose_tree(&decoded.nodes);
    assert_eq!(trees.len(), nodes.len(), "one root record per root node");

    let mut leaves = 0;
    for node in &decoded.nodes {
        if node.child_count == 0 {
            assert_eq!(node.first_child, POSE_LEAF, "{}: leaf sentinel", node.path);
            leaves += 1;
        }
    }
    assert!(leaves > 0, "the fixture must carry a leaf for this pin");

    // Every node's path id must index its own path.
    for node in &decoded.nodes {
        assert!(
            decoded.paths.contains(&node.path),
            "{}: node path must be in the table",
            node.path
        );
    }
    // The path table is deduplicated: ids are dense.
    let mut unique = decoded.paths.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), decoded.paths.len(), "path table is dense");
}

#[test]
fn merged_pose_matches_the_two_command_path() {
    for (name, times) in [
        ("animated.usda", [0.0, 10.0].as_slice()),
        ("cross_mode.usda", [1.0, 2.0].as_slice()),
        // Distinct per-slot payloads, so a swapped slot order changes bytes.
        ("two_deforming_meshes.usda", [1.0, 2.0].as_slice()),
        // A deep tree with many deforming prims.
        ("skinned.usda", [0.0, 1.0].as_slice()),
        // Deforming Points + Mesh with distinct material bindings.
        ("posed_appearance.usda", [1.0, 2.0].as_slice()),
    ] {
        let state = spawn_stage_owner();
        open_via_owner(&state, name);

        for &time in times {
            let nodes = request_animated_manifest(&state.sender(), Some(time))
                .expect("delta manifest should serialize");
            let mut paths = Vec::new();
            animated_geometry_paths(&nodes, &mut paths);
            assert!(
                !paths.is_empty(),
                "{} at {time} must carry deforming geometry for this pin",
                name
            );
            let batch = request_geometry_batch(&state.sender(), &paths, Some(time))
                .expect("geometry batch should serialize");

            let merged = request_animated_pose(&state.sender(), Some(time))
                .expect("merged pose should serialize");
            let decoded = decode_pose(&merged);
            if name == "posed_appearance.usda" {
                assert!(
                    decoded.materials.len() >= 2,
                    "the appearance fixture must bind at least two materials"
                );
                assert!(
                    decoded.nodes.iter().any(|node| node.is_points),
                    "the appearance fixture must carry a Points node"
                );
            }

            // The path table covers every node once, in first-visit pre-order.
            let mut table = Vec::new();
            pose_path_table(&nodes, &mut table);
            assert_eq!(decoded.paths, table, "{} at {time}: path table", name);
            assert_eq!(
                decoded.nodes.len(),
                table.len(),
                "{} at {time}: one node per path (delta paths are unique)",
                name
            );
            // The material table covers every binding once, first visit first,
            // and carries nothing the frame's nodes do not reference.
            let mut materials = Vec::new();
            pose_material_table(&nodes, &mut materials);
            assert_eq!(
                decoded.materials, materials,
                "{} at {time}: material table",
                name
            );
            for binding in &decoded.materials {
                assert!(
                    decoded
                        .nodes
                        .iter()
                        .any(|node| node.material.as_deref() == Some(binding.as_str())),
                    "{} at {time}: material {binding} is in the table but unbound",
                    name
                );
            }
            // The rebuilt tree is the JSON delta manifest, field for field.
            assert_pose_matches(&nodes, &rebuild_pose_tree(&decoded.nodes), name);

            // The geometry slots keep today's order and framing.
            assert_eq!(
                (merged.len() - batch.len()) % 4,
                0,
                "{} batch tail must start 4-byte aligned for in-place views",
                name
            );
            assert_eq!(
                u32::from_le_bytes(decoded.slots[0..4].try_into().unwrap()),
                0x5553_4247,
                "the tail is the batch framing"
            );
            assert_eq!(
                decoded.slots, batch,
                "{} geometry batch must be byte-identical",
                name
            );
            assert_eq!(
                u32::from_le_bytes(decoded.slots[8..12].try_into().unwrap()) as usize,
                paths.len(),
                "one slot per geometry_animated path"
            );
            // The slot order is the pre-order of the deforming nodes, so the
            // path table locates every slot in the flat node list too.
            for slot_path in &paths {
                assert!(
                    decoded.paths.contains(slot_path),
                    "{} at {time}: slot path {slot_path} must be in the path table",
                    name
                );
            }
        }
    }
}

/// A batch pose payload's frames, split the way the frontend must: the u32
/// frame count, then each frame self-delimited by its own prefixes (path
/// lengths, node records, batch slot lengths). Every frame stays 4-byte
/// aligned inside the payload, so the splits need no extra padding.
fn decode_pose_frames(payload: &[u8]) -> Vec<&[u8]> {
    let u32_at = |at: usize| u32::from_le_bytes(payload[at..at + 4].try_into().unwrap()) as usize;
    let count = u32_at(0);
    let mut cursor = 4;
    let mut frames = Vec::with_capacity(count);
    for _ in 0..count {
        let mut at = cursor;
        let paths = u32_at(at);
        at += 4;
        for _ in 0..paths {
            let len = u32_at(at);
            at += 4 + len;
        }
        at = align4(at);
        let materials = u32_at(at);
        at += 4;
        for _ in 0..materials {
            let len = u32_at(at);
            at = align4(at + 4 + len);
        }
        let nodes = u32_at(at);
        at += 4;
        for _ in 0..nodes {
            let flags = payload[at + 10];
            at += 16 + 64; // header (incl. material id) + 16 x f32 matrix
            if flags & POSE_FLAG_INSTANCES != 0 {
                let instances = u32_at(at);
                at += 4 + instances * 64;
            }
        }
        assert_eq!(u32_at(at), 0x5553_4247, "the tail is the batch framing");
        let slots = u32_at(at + 8);
        let mut slot_at = at + 12;
        for _ in 0..slots {
            let len = u32_at(slot_at + 4);
            slot_at = align4(slot_at + 8 + len);
        }
        assert_eq!(slot_at % 4, 0, "frames stay 4-byte aligned in the payload");
        frames.push(&payload[cursor..slot_at]);
        cursor = slot_at;
    }
    assert_eq!(
        cursor,
        payload.len(),
        "no trailing bytes after the last frame"
    );
    frames
}

#[test]
fn batch_pose_frames_match_single_pose_calls() {
    for (name, times) in [
        ("animated.usda", [0.0, 10.0, 24.0].as_slice()),
        // Distinct per-slot payloads, so a swapped frame order changes bytes.
        ("two_deforming_meshes.usda", [1.0, 2.0, 1.0].as_slice()),
    ] {
        let state = spawn_stage_owner();
        open_via_owner(&state, name);

        let batch = request_animated_pose_batch(&state.sender(), times)
            .expect("batch pose should serialize");
        let frames = decode_pose_frames(&batch);
        assert_eq!(frames.len(), times.len(), "{} one frame per time", name);

        for (frame, &time) in frames.iter().zip(times) {
            let single = request_animated_pose(&state.sender(), Some(time))
                .expect("merged pose should serialize");
            assert_eq!(*frame, single.as_slice(), "{} frame at {time}", name);
            decode_pose(frame);
        }
    }
}

#[test]
fn batch_pose_frames_are_decodable_by_the_frontend() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");
    let codes = request_time_codes(&state.sender()).expect("time codes should serialize");
    let times = [codes[0], codes[codes.len() / 2], codes[codes.len() - 1]];

    let batch =
        request_animated_pose_batch(&state.sender(), &times).expect("batch pose should serialize");
    let frames = decode_pose_frames(&batch);
    assert_eq!(frames.len(), times.len(), "one frame per authored code");
    for (frame, &time) in frames.iter().zip(&times) {
        let decoded = decode_pose(frame);
        assert!(!decoded.paths.is_empty(), "frame at {time} names its nodes");
        assert!(!decoded.nodes.is_empty(), "frame at {time} carries nodes");
        // The slot order is no longer the frame's own list: it is the
        // pre-order of the deforming nodes, which the reader re-derives.
        let mut paths = Vec::new();
        let mut flat = Vec::new();
        fn flatten<'a>(trees: &'a [PoseTree], out: &mut Vec<&'a PoseNode>) {
            for tree in trees {
                out.push(&tree.node);
                flatten(&tree.children, out);
            }
        }
        let trees = rebuild_pose_tree(&decoded.nodes);
        flatten(&trees, &mut flat);
        let mut seen = std::collections::HashSet::new();
        for node in flat {
            if node.has_geometry && node.geometry_animated && seen.insert(node.path.as_str()) {
                paths.push(node.path.clone());
            }
        }
        assert_eq!(
            decoded.slots,
            request_geometry_batch(&state.sender(), &paths, Some(time))
                .expect("geometry batch should serialize")
                .as_slice(),
            "frame at {time} carries the same geometry batch in the same slot order"
        );
    }
}

#[test]
fn batch_pose_omits_times_outside_the_authored_codes() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");
    let codes = request_time_codes(&state.sender()).expect("time codes should serialize");
    let (first, last) = (codes[0], codes[codes.len() - 1]);

    // Past the last authored code: dropped, the count reflects the actual.
    let batch = request_animated_pose_batch(&state.sender(), &[first, last + 1.0])
        .expect("batch pose should serialize");
    let frames = decode_pose_frames(&batch);
    assert_eq!(frames.len(), 1, "the out-of-range time is omitted");
    assert_eq!(
        frames[0],
        request_animated_pose(&state.sender(), Some(first))
            .expect("merged pose should serialize")
            .as_slice(),
        "the in-range frame survives byte-identical"
    );

    // A time before the first authored code is out of range too.
    let early = request_animated_pose_batch(&state.sender(), &[first - 1.0])
        .expect("batch pose should serialize");
    assert_eq!(decode_pose_frames(&early).len(), 0, "early time is omitted");

    // An empty slice is an empty payload, not an error.
    let none = request_animated_pose_batch(&state.sender(), &[]).expect("empty batch is valid");
    assert_eq!(none, 0u32.to_le_bytes(), "empty times -> frame_count 0");
}

#[test]
fn batch_pose_of_one_time_equals_the_single_pose_command() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");
    let codes = request_time_codes(&state.sender()).expect("time codes should serialize");
    let time = codes[codes.len() / 2];

    let single =
        request_animated_pose(&state.sender(), Some(time)).expect("merged pose should serialize");
    let batch =
        request_animated_pose_batch(&state.sender(), &[time]).expect("batch pose should serialize");
    let mut expected = 1u32.to_le_bytes().to_vec();
    expected.extend(single);
    assert_eq!(batch, expected, "a one-element batch is the single frame");
}

#[test]
fn batch_pose_keeps_duplicate_times() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");
    let codes = request_time_codes(&state.sender()).expect("time codes should serialize");
    let time = codes[0];

    let batch = request_animated_pose_batch(&state.sender(), &[time, time])
        .expect("batch pose should serialize");
    let frames = decode_pose_frames(&batch);
    assert_eq!(frames.len(), 2, "duplicate times are the caller's contract");
    assert_eq!(frames[0], frames[1], "both duplicates carry the same frame");
}

// The frame cache's contract: a repeated playhead time is answered from the
// assembled frame — same bytes, one counted hit, nothing re-tessellated and
// no delta walk (a miss would grow the tessellation count only on a cold
// mesh, so the hit count is the timing-independent proof). The idle-gap warmup
// is switched off so every hit below is this test's own request.
#[test]
fn pose_frame_cache_serves_a_repeated_time_from_the_assembled_frame() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");
    state.disable_warmup();
    let codes = request_time_codes(&state.sender()).expect("time codes should serialize");
    let time = codes[codes.len() / 2];

    let first = request_animated_pose(&state.sender(), Some(time)).expect("pose should serialize");
    let tessellations = state.mesh_tessellations();
    assert_eq!(state.pose_frame_hits(), 0, "the first pose is a miss");

    let second =
        request_animated_pose(&state.sender(), Some(time)).expect("repeat pose should serialize");
    assert_eq!(first, second, "the cached frame is byte-identical");
    assert_eq!(
        state.pose_frame_hits(),
        1,
        "the repeat was a frame cache hit"
    );
    assert_eq!(
        state.mesh_tessellations(),
        tessellations,
        "a hit tessellates nothing"
    );

    // A different time is its own frame: a miss, not a hit.
    let other = codes[0];
    if other != time {
        let _ = request_animated_pose(&state.sender(), Some(other))
            .expect("another time should serialize");
        assert_eq!(state.pose_frame_hits(), 1, "a new time is a miss");
    }
}

// The one failure mode that matters: a cached frame whose inputs changed.
// Every mutation clears the frame cache through the MeshCache's clear path, so
// the pose after an edit is re-assembled and reflects the edit.
#[test]
fn a_pose_after_an_edit_never_serves_the_cached_frame() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");
    state.disable_warmup();
    let codes = request_time_codes(&state.sender()).expect("time codes should serialize");
    let time = codes[codes.len() / 2];

    let before = request_animated_pose(&state.sender(), Some(time)).expect("pose should serialize");
    request_set_attribute_value(
        &state.sender(),
        "/Scene/Pulse",
        "visibility",
        &payload("token", serde_json::json!("invisible")),
        None,
    )
    .expect("visibility should be editable");

    let after = request_animated_pose(&state.sender(), Some(time)).expect("pose should serialize");
    assert_ne!(before, after, "the edit must reach the next pose");
    assert_eq!(
        state.pose_frame_hits(),
        0,
        "the edit cleared the frame cache"
    );

    // The re-assembled frame is cached in turn.
    let again =
        request_animated_pose(&state.sender(), Some(time)).expect("repeat pose should serialize");
    assert_eq!(after, again, "the post-edit frame is cached");
    assert_eq!(state.pose_frame_hits(), 1);
}

// A transform-only edit takes the warm path (`warm_xform_keep`, which keeps
// the tree and the manifest skeleton), so it must clear the frame cache
// itself: those frames embed the edited prim's matrix.
#[test]
fn a_pose_after_a_warm_xform_edit_never_serves_the_cached_frame() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");
    state.disable_warmup();
    let codes = request_time_codes(&state.sender()).expect("time codes should serialize");
    let time = codes[codes.len() / 2];

    // Pulse authors only xformOp:translate; give it an authored rotate as well
    // so a warm edit has a matrix element to change.
    request_set_attribute_value(
        &state.sender(),
        "/Scene/Pulse",
        "xformOp:rotateXYZ",
        &payload("float3", serde_json::json!([0, 0, 30])),
        None,
    )
    .expect("creating the rotate should succeed");
    request_set_attribute_value(
        &state.sender(),
        "/Scene/Pulse",
        "xformOpOrder",
        &payload(
            "token_array",
            serde_json::json!(["xformOp:translate", "xformOp:rotateXYZ"]),
        ),
        None,
    )
    .expect("authoring the order should succeed");

    let before = request_animated_pose(&state.sender(), Some(time)).expect("pose should serialize");
    let _ = request_animated_pose(&state.sender(), Some(time)).expect("pose should serialize");
    assert_eq!(state.pose_frame_hits(), 1, "the frame is warm");

    // A default-time xform op write: the warm path, no tree or skeleton rebuild.
    request_set_attribute_value(
        &state.sender(),
        "/Scene/Pulse",
        "xformOp:rotateXYZ",
        &payload("float3", serde_json::json!([0, 0, 60])),
        None,
    )
    .expect("the rotate edit should succeed");

    let after = request_animated_pose(&state.sender(), Some(time)).expect("pose should serialize");
    assert_ne!(
        before, after,
        "the warm edit must reach the next pose, not serve the cached frame"
    );
    assert_eq!(
        state.pose_frame_hits(),
        1,
        "the warm edit cleared the frame cache"
    );
}
