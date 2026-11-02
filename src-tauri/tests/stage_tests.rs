use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;

use usdbee_lib::parser::{resolve_remote_dependencies, scan_dependencies};
use usdbee_lib::stage::{
    open_stage, request_stage_details, request_stage_tree, serialize_tree, spawn_stage_owner,
    PrimNode, StageRequest, StageState,
};
use usdbee_lib::values::PrimDetails;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

#[test]
fn z_up_stage_reports_z_up_axis() {
    // basic.usda authors upAxis = "Z".
    let (_stage, info) = open_stage(&fixture("basic.usda")).expect("basic stage should open");
    assert_eq!(info.up_axis, "Z");
}

#[test]
fn y_up_stage_reports_y_up_axis() {
    let (_stage, info) = open_stage(&fixture("yup.usda")).expect("yup stage should open");
    assert_eq!(info.up_axis, "Y");
}

#[test]
fn missing_up_axis_defaults_to_y() {
    let (_stage, info) = open_stage(&fixture("no_upaxis.usda")).expect("stage should open");
    assert_eq!(info.up_axis, "Y");
}

#[test]
fn kitchen_set_asset_reports_z_up_axis() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/Kitchen_set/Kitchen_set_instanced.usd");
    if !path.exists() {
        eprintln!("skipping kitchen_set_asset_reports_z_up_axis: asset not present");
        return;
    }
    let (_stage, info) = open_stage(&path).expect("kitchen set should open");
    assert_eq!(info.up_axis, "Z");
}

#[test]
fn fetched_remote_reference_composes_into_the_stage() {
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("HTTP server should bind");
    let port = listener.local_addr().expect("server address").port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("HTTP request should arrive");
        let mut request = [0; 1024];
        let _ = stream.read(&mut request);
        let body =
            "#usda 1.0\n\ndef Xform \"Remote\"\n{\n    def Sphere \"Wheel\"\n    {\n    }\n}\n";
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .expect("HTTP response should be written");
    });

    let dir = tempfile::tempdir().expect("temp dir should be created");
    let root = dir.path().join("remote_root.usda");
    let url = format!(
        "http://127.0.0.1:{}/remote_{}/asset.usda",
        port,
        std::process::id()
    );
    fs::write(
        &root,
        format!(
            "#usda 1.0\n\ndef Xform \"Scene\"\n{{\n    def \"Car\" (\n        references = @{}@</Remote>\n    )\n    {{\n    }}\n}}\n",
            url
        ),
    )
    .expect("test stage should be written");

    let mut scan = scan_dependencies(&root).expect("dependencies should scan");
    resolve_remote_dependencies(&mut scan, "").expect("remote layer should download");
    let (stage, info) = open_stage(&root).expect("stage should open after fetching");
    server.join().expect("HTTP server should finish");

    assert!(
        info.composition_errors.is_empty(),
        "remote reference should resolve: {:?}",
        info.composition_errors
    );
    let tree = serialize_tree(&stage).expect("tree should serialize");
    let car = node(&tree[0].children, "/Scene/Car");
    assert_eq!(car.children.len(), 1);
    assert_eq!(car.children[0].path, "/Scene/Car/Wheel");
}

#[test]
fn opens_basic_stage_with_default_time_codes_per_second() {
    let (_stage, info) = open_stage(&fixture("basic.usda")).expect("basic stage should open");

    assert!(!info.root_layer.is_empty());
    assert_eq!(info.time_codes_per_second, 24.0);
    assert!(info.composition_errors.is_empty());
}

#[test]
fn opens_generated_usdc_and_usdz_stages() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let source = fixture("basic.usda");
    let layer =
        openusd::sdf::Layer::open(source.to_str().expect("fixture path should be valid UTF-8"))
            .expect("source layer should open");

    for extension in ["usdc", "usdz"] {
        let path = dir.path().join(format!("basic.{}", extension));
        layer
            .export(
                path.to_str()
                    .expect("temporary stage path should be valid UTF-8"),
            )
            .expect("binary stage should be generated");

        let (stage, info) = open_stage(&path).expect("generated stage should open");
        assert!(
            info.composition_errors.is_empty(),
            "{} composition errors: {:?}",
            extension,
            info.composition_errors
        );
        let tree = serialize_tree(&stage).expect("generated stage tree should serialize");
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].path, "/World");
        assert_eq!(tree[0].children.len(), 2);
    }
}

#[test]
fn opens_stage_with_resolved_reference() {
    let (_stage, info) =
        open_stage(&fixture("scene_with_ref.usda")).expect("referenced stage should open");

    assert!(info.composition_errors.is_empty());
}

#[test]
fn missing_reference_is_a_recoverable_composition_error() {
    let dir = tempfile::tempdir().expect("temp dir should be created");
    let root = dir.path().join("missing_ref.usda");
    fs::write(
        &root,
        r#"#usda 1.0

def Xform "Scene"
{
    def "Broken" (
        references = @./missing.usda@
    )
    {
    }
}
"#,
    )
    .expect("test stage should be written");

    let (_stage, info) = open_stage(&root).expect("missing references must not fail stage open");

    assert!(!info.composition_errors.is_empty());
}

#[test]
fn search_path_reference_resolves_only_via_resolver_roots() {
    // The referenced asset exists ONLY under the extracted-usdz resolver root,
    // under a name unique to this test process, so no anchor-dir or cwd
    // fallback can find it: removing the resolver search paths must fail here.
    let pin = format!("resolver_pin_{}", std::process::id());
    let pin_dir = usdbee_lib::get_usdbee_cache_dir()
        .join("extracted")
        .join(&pin);
    fs::create_dir_all(&pin_dir).expect("resolver root should be creatable");
    fs::write(
        pin_dir.join("asset.usda"),
        "#usda 1.0\n(\n    defaultPrim = \"Pinned\"\n)\n\ndef Xform \"Pinned\"\n{\n}\n",
    )
    .expect("pinned asset should be written");

    let dir = tempfile::tempdir().expect("temp dir should be created");
    let root = dir.path().join("search_pinned.usda");
    fs::write(
        &root,
        format!(
            "#usda 1.0\n\ndef Xform \"Scene\"\n{{\n    def \"Pinned\" (\n        references = @{}/asset.usda@\n    )\n    {{\n    }}\n}}\n",
            pin
        ),
    )
    .expect("test stage should be written");

    let (_stage, info) = open_stage(&root).expect("search-path stage should open");

    let _ = fs::remove_dir_all(&pin_dir);
    assert!(
        info.composition_errors.is_empty(),
        "search-path reference {}/asset.usda must resolve via the resolver search paths: {:?}",
        pin,
        info.composition_errors
    );
}

fn open_via_owner(state: &StageState, name: &str) {
    let (reply_tx, reply_rx) = mpsc::channel();
    state
        .sender
        .send(StageRequest::Open {
            path: fixture(name),
            is_usdz: false,
            reply: reply_tx,
        })
        .expect("stage owner should accept an open request");
    reply_rx
        .recv()
        .expect("stage owner should reply")
        .expect("stage should open");
}

fn tree_via_owner(state: &StageState) -> Vec<PrimNode> {
    request_stage_tree(&state.sender).expect("tree should serialize")
}

fn details_via_owner(state: &StageState, path: &str, time: Option<f64>) -> PrimDetails {
    request_stage_details(&state.sender, path, time).expect("details should serialize")
}

fn attribute<'a>(details: &'a PrimDetails, name: &str) -> &'a usdbee_lib::values::AttributeInfo {
    details
        .attributes
        .iter()
        .find(|a| a.name == name)
        .unwrap_or_else(|| panic!("expected attribute {} in {:?}", name, details.attributes))
}

fn node<'a>(nodes: &'a [PrimNode], path: &str) -> &'a PrimNode {
    nodes
        .iter()
        .find(|n| n.path == path)
        .unwrap_or_else(|| panic!("expected prim {} in tree {:?}", path, nodes))
}

#[test]
fn basic_tree_matches_authored_hierarchy() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");
    let tree = tree_via_owner(&state);

    assert_eq!(tree.len(), 1, "pseudo-root has one child: {:?}", tree);
    let world = &tree[0];
    assert_eq!(world.path, "/World");
    assert_eq!(world.name, "World");
    assert_eq!(world.type_name, "Xform");
    assert_eq!(world.kind, "");
    assert!(world.is_active);
    assert!(!world.is_instance);
    assert!(!world.is_abstract);

    assert_eq!(world.children.len(), 2);
    let ground = node(&world.children, "/World/Ground");
    assert_eq!(ground.type_name, "Xform");
    assert!(ground.is_active);
    assert!(ground.children.is_empty());

    let ball = node(&world.children, "/World/Ball");
    assert_eq!(ball.type_name, "Mesh");
    assert!(ball.is_active);
    assert!(ball.children.is_empty());
}

#[test]
fn variants_tree_reflects_selected_variant_children() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "variants.usda");
    let tree = tree_via_owner(&state);

    assert_eq!(tree.len(), 1);
    let prop = &tree[0];
    assert_eq!(prop.path, "/Prop");
    assert_eq!(prop.type_name, "Xform");
    assert_eq!(prop.children.len(), 1, "only the selected variant composes");
    let shape = &prop.children[0];
    assert_eq!(shape.path, "/Prop/Shape");
    assert_eq!(shape.type_name, "Sphere");
    assert!(shape.children.is_empty());
}

#[test]
fn instanced_tree_lists_instances_without_children() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "instanced.usda");
    let tree = tree_via_owner(&state);

    assert_eq!(tree.len(), 1);
    let scene = &tree[0];
    assert_eq!(scene.path, "/Scene");
    assert_eq!(scene.children.len(), 2);
    for wheel in &scene.children {
        assert!(wheel.is_instance, "{} must be an instance", wheel.path);
        assert_eq!(wheel.type_name, "Xform");
        assert!(wheel.children.is_empty(), "instances must not expand");
    }
    assert_eq!(scene.children[0].path, "/Scene/WheelA");
    assert_eq!(scene.children[1].path, "/Scene/WheelB");
}

#[test]
fn referenced_children_appear_under_referencing_prim() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "scene_with_ref.usda");
    let tree = tree_via_owner(&state);

    assert_eq!(tree.len(), 1);
    let car = node(&tree[0].children, "/Scene/Car");
    assert_eq!(car.type_name, "Xform");
    assert_eq!(car.children.len(), 2);
    let wheel = &car.children[0];
    assert_eq!(wheel.path, "/Scene/Car/Wheel");
    assert_eq!(wheel.type_name, "Sphere");
    assert_eq!(car.children[1].path, "/Scene/Car/WheelMesh");
    assert_eq!(car.children[1].type_name, "Mesh");
}

#[test]
fn reopening_a_stage_replaces_the_tree_completely() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");
    let first = tree_via_owner(&state);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].path, "/World");

    open_via_owner(&state, "variants.usda");
    let second = tree_via_owner(&state);
    assert_eq!(second.len(), 1, "no stale nodes from the previous stage");
    assert_eq!(second[0].path, "/Prop");
}

#[test]
fn tree_request_without_open_stage_fails() {
    let state = spawn_stage_owner();
    let error = request_stage_tree(&state.sender).expect_err("no stage is open");
    assert!(error.contains("no stage open"), "got: {}", error);
}

#[test]
fn stage_owner_opens_stages_and_survives_open_errors() {
    let state = spawn_stage_owner();
    let (reply_tx, reply_rx) = mpsc::channel();
    state
        .sender
        .send(StageRequest::Open {
            path: fixture("basic.usda"),
            is_usdz: false,
            reply: reply_tx,
        })
        .expect("stage owner should accept an open request");

    let info = reply_rx
        .recv()
        .expect("stage owner should reply")
        .expect("stage owner should open the basic stage");
    assert!(!info.root_layer.is_empty());
    assert_eq!(info.time_codes_per_second, 24.0);
    assert!(info.composition_errors.is_empty());

    let (reply_tx, reply_rx) = mpsc::channel();
    state
        .sender
        .send(StageRequest::Open {
            path: fixture("does-not-exist.usda"),
            is_usdz: false,
            reply: reply_tx,
        })
        .expect("stage owner should still accept requests");

    let error = reply_rx
        .recv()
        .expect("stage owner should reply to the failed open")
        .expect_err("opening a nonexistent stage should fail");
    assert!(error.contains("does-not-exist.usda"));
}

#[test]
fn details_authored_attribute_resolves_authored_value() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");
    let details = details_via_owner(&state, "/World/Ball", None);

    assert_eq!(details.path, "/World/Ball");
    assert_eq!(details.type_name, "Mesh");
    assert!(details.is_active);
    assert!(!details.is_instance);

    let radius = attribute(&details, "radius");
    assert_eq!(radius.type_name, "float");
    assert!(radius.authored);
    assert_eq!(radius.variability, "varying");
    assert_eq!(radius.value.r#type, "float");
    assert_eq!(radius.value.data, serde_json::json!(1.0));

    let unused = attribute(&details, "unusedBySchema");
    assert_eq!(unused.value.r#type, "double");
    assert_eq!(unused.value.data, serde_json::json!(7.0));
}

#[test]
fn details_unauthored_attribute_is_never_an_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");
    let details = details_via_owner(&state, "/World/Ball", None);

    let declared = attribute(&details, "declaredOnly");
    assert!(!declared.authored);
    assert_eq!(declared.value.r#type, "unauthored");
    assert_eq!(declared.value.data, serde_json::json!(null));
}

#[test]
fn details_exotic_types_serialize_without_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "instanced.usda");
    let details = details_via_owner(&state, "/Scene", None);

    let roughness = attribute(&details, "roughness");
    assert_eq!(roughness.value.r#type, "half");
    assert_eq!(roughness.value.data, serde_json::json!(0.5));

    let asset = attribute(&details, "refAsset");
    assert_eq!(asset.value.r#type, "assetpath");
    assert_eq!(asset.value.data, serde_json::json!("./asset.usda"));

    // An unregistered-typed attribute (spline) is exotic: it must come back
    // as a readable string representation, never abort the whole payload.
    // The prim's customData dictionary exercises the same path via metadata.
    let knots = attribute(&details, "knots");
    assert_eq!(knots.value.r#type, "unsupported");
    assert!(knots.value.data.as_str().unwrap_or("").contains('5'));

    let custom_data = details
        .metadata
        .iter()
        .find(|(key, _)| key == "customData")
        .map(|(_, value)| value)
        .expect("customData metadata");
    assert_eq!(custom_data.r#type, "dict");
    assert_eq!(
        custom_data.data["style"],
        serde_json::json!({ "type": "string", "data": "flat" })
    );
}

#[test]
fn details_variant_sets_list_options_and_authored_selection() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "variants.usda");
    let details = details_via_owner(&state, "/Prop", None);

    assert_eq!(details.variant_sets.len(), 2);
    let color = details
        .variant_sets
        .iter()
        .find(|s| s.name == "color")
        .expect("color variant set");
    assert!(color.options.contains(&"red".to_string()));
    assert!(color.options.contains(&"blue".to_string()));
    assert_eq!(color.authored_selection.as_deref(), Some("red"));

    let size = details
        .variant_sets
        .iter()
        .find(|s| s.name == "size")
        .expect("size variant set");
    assert!(size.options.contains(&"big".to_string()));
    assert!(size.options.contains(&"small".to_string()));
    assert_eq!(size.authored_selection.as_deref(), Some("big"));
}

#[test]
fn details_animated_values_differ_by_time() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "animated.usda");

    let at_start = details_via_owner(&state, "/Scene/Pulse", Some(0.0));
    let at_mid = details_via_owner(&state, "/Scene/Pulse", Some(10.0));

    let start_size = attribute(&at_start, "size");
    assert_eq!(start_size.value.r#type, "double");
    let start = start_size.value.data.as_f64().expect("size is a number");
    let mid = attribute(&at_mid, "size")
        .value
        .data
        .as_f64()
        .expect("size is a number");
    assert_eq!(start, 1.0);
    assert!(
        mid > start && mid < 5.0,
        "interpolated size at t=10, got {}",
        mid
    );
}

#[test]
fn details_instance_points_at_prototype() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "instanced.usda");
    let details = details_via_owner(&state, "/Scene/WheelA", None);

    assert!(details.is_instance);
    let prototype = details
        .instance_of
        .as_deref()
        .expect("instance must point at its prototype");
    assert_eq!(prototype, "/__Prototype_0");

    assert!(details
        .metadata
        .iter()
        .any(|(key, value)| key == "instanceable" && value.data == serde_json::json!(true)));
}

#[test]
fn details_local_and_world_transforms_differ() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");
    let details = details_via_owner(&state, "/World/Ground", None);

    let local = details.local_transform.expect("ground has a translate op");
    assert_eq!(local[12], 0.0);
    assert_eq!(local[13], 0.0);
    assert_eq!(local[14], -1.0);

    let world = details.world_transform.expect("world composes the parent");
    assert_eq!(world[12], 1.0);
    assert_eq!(world[13], 2.0);
    assert_eq!(world[14], 2.0);
}

fn assert_matrix_close(expected: &[f64; 16], actual: &[f64; 16]) {
    for (i, (e, a)) in expected.iter().zip(actual).enumerate() {
        assert!(
            (e - a).abs() < 1e-9,
            "matrix element {i}: expected {e}, got {a}"
        );
    }
}

#[test]
fn details_composes_euler_ops_in_authored_order() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "xforms.usda");

    // xformOp:rotateZYX (90, 90, 90): the first axis named is the most local
    // (USD xformOp.h), so the row-vector matrix is Rz(90)·Ry(90)·Rx(90).
    let triplet = details_via_owner(&state, "/World/TripletZYX", None)
        .local_transform
        .expect("triplet op is evaluated");
    assert_matrix_close(
        &[
            0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        &triplet,
    );

    // Single-axis ops listed [rotateZ, rotateY, rotateX]: ops apply in the
    // reverse of the listed order, so the matrix is Rx(90)·Ry(90)·Rz(90).
    let singles = details_via_owner(&state, "/World/SinglesZYX", None)
        .local_transform
        .expect("single-axis ops are evaluated");
    assert_matrix_close(
        &[
            0.0, 0.0, -1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        &singles,
    );

    assert!(
        (triplet[5] - singles[5]).abs() > 1.0,
        "authored order must change the matrix"
    );
}

#[test]
fn details_reset_xform_stack_discards_prior_ops_and_inheritance() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "xforms.usda");
    let details = details_via_owner(&state, "/World/Reset", None);

    // The translate before !resetXformStack! is discarded; only rotateZ(90)
    // survives, so the local matrix is a pure rotation with no translation.
    let local = details
        .local_transform
        .expect("ops after the reset compose");
    assert_matrix_close(
        &[
            0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        &local,
    );

    // The reset also stops the parent /World translate (10, 0, 0) from
    // composing into the world transform.
    let world = details
        .world_transform
        .expect("world equals the reset local");
    assert_matrix_close(&local, &world);
}

#[test]
fn details_suffixed_pivot_op_evaluates_as_translate() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "xforms.usda");
    let local = details_via_owner(&state, "/World/Pivoted", None)
        .local_transform
        .expect("suffixed pivot op evaluates as its base translate");
    assert_matrix_close(
        &[
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 5.0, 0.0, 1.0, 1.0,
        ],
        &local,
    );

    // The parent /World translate (10, 0, 0) composes after the local.
    let world = details_via_owner(&state, "/World/Pivoted", None)
        .world_transform
        .expect("world composes the parent");
    assert_matrix_close(
        &[
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 15.0, 0.0, 1.0, 1.0,
        ],
        &world,
    );
}

#[test]
fn details_maya_pivot_pattern_composes_pivot_relative_rotation() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "xforms.usda");
    // `!inverted!` and `!invert!` are both USD inversion markers.
    for path in ["/World/MayaPivot", "/World/MayaPivotInvert"] {
        let local = details_via_owner(&state, path, None)
            .local_transform
            .expect("the pivot pattern evaluates");
        // Ops pre-multiply left-to-right: pivot(5,0,0), rotateZ(90), the pivot
        // inverse, then translate(0,0,1), so the matrix fixes the pivot point
        // under the rotation and shifts by (5, -5, 1).
        assert_matrix_close(
            &[
                0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 5.0, -5.0, 1.0, 1.0,
            ],
            &local,
        );
    }
}

#[test]
fn details_time_sampled_orient_has_no_transform_at_default_time() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "xforms.usda");
    // /World/TimeOrient only authors samples at time 1s+: at default time
    // there is no value, which is no-transform, not a bad op.
    let details = details_via_owner(&state, "/World/TimeOrient", None);
    assert!(
        details.local_transform.is_none(),
        "no value at this time means no transform"
    );
    let at_one = details_via_owner(&state, "/World/TimeOrient", Some(1.0))
        .local_transform
        .expect("the quaternion evaluates at its authored time");
    assert_matrix_close(
        &[
            0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        &at_one,
    );
}

#[test]
fn details_unsupported_xform_ops_yield_no_transform() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "xforms.usda");
    let details = details_via_owner(&state, "/World/Unsupported", None);

    assert!(
        details.local_transform.is_none(),
        "unsupported ops must not silently compose a wrong matrix"
    );
    assert!(details.world_transform.is_none());
}

#[test]
fn details_plain_prim_without_ops_reports_identity_local_and_parent_world() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");
    let details = details_via_owner(&state, "/World/Ball", None);

    // A plain Mesh authors no xformOpOrder: it reports the identity LOCAL
    // transform (identity, not None, so the gizmo gate keeps it editable —
    // None is reserved for ops that cannot be evaluated) ...
    let local = details
        .local_transform
        .expect("no authored ops means identity, not None");
    assert_matrix_close(
        &[
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
        &local,
    );

    // ... and the WORLD transform still composes the parent /World
    // translate (1, 2, 3), so the gizmo can anchor to a real world pose.
    let world = details
        .world_transform
        .expect("the world composes the parent chain");
    assert_matrix_close(
        &[
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 2.0, 3.0, 1.0,
        ],
        &world,
    );
}

#[test]
fn details_reference_prim_lists_composition_arc() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "scene_with_ref.usda");
    let details = details_via_owner(&state, "/Scene/Car", None);

    assert!(
        details
            .composition_arcs
            .iter()
            .any(|arc| arc.starts_with("references:") && arc.contains("asset.usda")),
        "arcs: {:?}",
        details.composition_arcs
    );
}

#[test]
fn details_request_without_open_stage_fails() {
    let state = spawn_stage_owner();
    let error = request_stage_details(&state.sender, "/World", None).expect_err("no stage is open");
    assert!(error.contains("no stage open"), "got: {}", error);
}

#[test]
fn details_for_missing_prim_is_a_readable_error() {
    let state = spawn_stage_owner();
    open_via_owner(&state, "basic.usda");
    let error =
        request_stage_details(&state.sender, "/World/Nope", None).expect_err("prim does not exist");
    assert!(error.contains("prim not found"), "got: {}", error);
    // The owner survives the failed lookup.
    let details = details_via_owner(&state, "/World/Ball", None);
    assert_eq!(details.type_name, "Mesh");
}
