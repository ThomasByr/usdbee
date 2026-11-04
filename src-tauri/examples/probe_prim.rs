// Human-readable selection diagnostic: dumps the prim tree, the render
// manifest and per-geometry local/world vertex bounds so a gizmo/selection
// mismatch can be traced on real assets.
//
//   USD_PATH=<file> [NAME_FILTER=Cabinet] cargo run --manifest-path
//   src-tauri/Cargo.toml --example probe_prim
use std::path::PathBuf;

use openusd::sdf;
use openusd::usd::Prim;
use usdbee_lib::stage::{RenderNode, open_stage, serialize_render_manifest, serialize_tree};
use usdbee_lib::tessellation::tessellate_prim;
use usdbee_lib::values::local_transform;

fn fmt_matrix(m: &[f64; 16]) -> String {
    // Row-major, row-vector (USD): translation = elements 12..14.
    format!(
        "[{:7.2} {:7.2} {:7.2} | {:7.2}]",
        m[0], m[1], m[2], m[12]
    ) + &format!(
        " [{:7.2} {:7.2} {:7.2} | {:7.2}]",
        m[4], m[5], m[6], m[13]
    ) + &format!(
        " [{:7.2} {:7.2} {:7.2} | {:7.2}]",
        m[8], m[9], m[10], m[14]
    )
}

fn fmt_point(p: [f64; 3]) -> String {
    format!("({:8.2}, {:8.2}, {:8.2})", p[0], p[1], p[2])
}

fn transform_point(m: &[f64; 16], p: [f32; 3]) -> [f64; 3] {
    let p = p.map(f64::from);
    std::array::from_fn(|axis| {
        p[0] * m[axis] + p[1] * m[4 + axis] + p[2] * m[8 + axis] + m[12 + axis]
    })
}

fn world_transform(prim: &Prim, time: Option<f64>) -> Option<[f64; 16]> {
    let mut chain = Vec::new();
    let mut current = Some(prim.clone());
    while let Some(ancestor) = current {
        current = ancestor.parent();
        let reset = matches!(
            ancestor
                .attribute("xformOpOrder")
                .get_at::<openusd::sdf::Value>(time.map(openusd::usd::TimeCode::new))
                .unwrap(),
            Some(openusd::sdf::Value::TokenVec(ops))
                if ops.iter().any(|op| op.as_str() == "!resetXformStack!")
        );
        chain.push(ancestor);
        if reset {
            break;
        }
    }
    let mut acc = openusd::gf::Matrix4d::IDENTITY;
    for ancestor in chain.iter().rev() {
        acc = local_transform(ancestor, time).ok()?? * acc;
    }
    Some(acc.0)
}

fn print_tree(nodes: &[usdbee_lib::stage::PrimNode], depth: usize) {
    for node in nodes {
        let flags = [
            ("instance", node.is_instance),
            ("inactive", !node.is_active),
        ]
        .iter()
        .filter(|(_, on)| *on)
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(" ");
        println!(
            "TREE {:indent$}{} [{}] {}",
            "",
            node.path,
            node.type_name,
            flags,
            indent = depth * 2
        );
        print_tree(&node.children, depth + 1);
    }
}

fn print_manifest(nodes: &[RenderNode], depth: usize) {
    for node in nodes {
        println!(
            "MANIFEST {:indent$}{} [{}] geom={} transform={}",
            "",
            node.path,
            node.type_name,
            node.has_geometry,
            fmt_matrix(&node.transform),
            indent = depth * 2
        );
        for (index, instance) in node.instances.iter().enumerate() {
            println!(
                "INSTANCE {}/{} {}",
                node.path,
                index,
                fmt_matrix(instance)
            );
        }
        print_manifest(&node.children, depth + 1);
    }
}

fn main() {
    let path = std::env::var_os("USD_PATH")
        .map(PathBuf::from)
        .expect("USD_PATH=<usd file>");
    let filter = std::env::var("NAME_FILTER").unwrap_or_default();
    let (stage, info) = open_stage(&path).unwrap();
    let time = Some(info.start_time_code);
    println!(
        "STAGE {} up={} start={}",
        path.display(),
        info.up_axis,
        info.start_time_code
    );

    let tree = serialize_tree(&stage).unwrap();
    print_tree(&tree, 0);

    println!("\n--- manifest ---");
    let manifest = serialize_render_manifest(&stage, time).unwrap();
    print_manifest(&manifest, 0);

    if !filter.is_empty() {
        println!("\n--- prims matching {filter:?} ---");
        let mut all_paths = Vec::new();
        collect_tree_paths(&tree, &mut all_paths);
        for path in all_paths {
            if !path.contains(&filter) {
                continue;
            }
            let prim = stage.prim(sdf::try_into_path(&path).unwrap()).unwrap();
            let world = world_transform(&prim, time);
            println!(
                "PRIM {} [{}] instance={:?} world={}",
                prim.path(),
                prim.type_name().unwrap().map(|t| t.to_string()).unwrap_or_default(),
                prim.is_instance().unwrap(),
                world
                    .as_ref()
                    .map(fmt_matrix)
                    .unwrap_or_else(|| "none".into())
            );
            if let Some(world) = world {
                let mut bounds: Option<([f64; 3], [f64; 3])> = None;
                let mut stack2 = vec![prim.clone()];
                while let Some(descendant) = stack2.pop() {
                    if let Some(mesh) = tessellate_prim(&descendant, time).unwrap() {
                        for vertex in &mesh.positions {
                            let point = transform_point(&world, *vertex);
                            bounds = Some(match bounds {
                                None => (point, point),
                                Some((mut min, mut max)) => {
                                    for axis in 0..3 {
                                        min[axis] = min[axis].min(point[axis]);
                                        max[axis] = max[axis].max(point[axis]);
                                    }
                                    (min, max)
                                }
                            });
                        }
                    }
                    for child in descendant.children().unwrap() {
                        stack2.push(child);
                    }
                }
                if let Some((min, max)) = bounds {
                    let center: [f64; 3] =
                        std::array::from_fn(|axis| (min[axis] + max[axis]) / 2.0);
                    println!(
                        "  world-vertex-bounds min={} max={} center={}",
                        fmt_point(min),
                        fmt_point(max),
                        fmt_point(center)
                    );
                } else {
                    println!("  no tessellated geometry under this prim");
                }
            }
        }
    }

    drop(stage);
}

fn collect_tree_paths(nodes: &[usdbee_lib::stage::PrimNode], out: &mut Vec<String>) {
    for node in nodes {
        out.push(node.path.clone());
        collect_tree_paths(&node.children, out);
    }
}
