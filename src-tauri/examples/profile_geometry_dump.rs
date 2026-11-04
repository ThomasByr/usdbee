use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use openusd::gf;
use openusd::sdf::{self, Value};
use openusd::usd::TimeCode;
use usdbee_lib::stage::{
    open_stage, serialize_render_manifest, serialize_tree, PrimNode, RenderNode,
};
use usdbee_lib::tessellation::{pack_geometry, tessellate_prim};
use usdbee_lib::values::local_transform;

fn bits64(values: &[f64]) -> String {
    values
        .iter()
        .map(|value| format!("{:016x}", value.to_bits()))
        .collect::<Vec<_>>()
        .join(",")
}

fn bits32(values: &[f32]) -> String {
    values
        .iter()
        .map(|value| format!("{:08x}", value.to_bits()))
        .collect::<Vec<_>>()
        .join(",")
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

fn tree_paths(nodes: &[PrimNode], paths: &mut BTreeSet<String>) {
    for node in nodes {
        paths.insert(node.path.clone());
        tree_paths(&node.children, paths);
    }
}

fn manifest_nodes<'a>(nodes: &'a [RenderNode], out: &mut Vec<&'a RenderNode>) {
    for node in nodes {
        out.push(node);
        manifest_nodes(&node.children, out);
    }
}

fn positions(bytes: &[u8]) -> Vec<[f32; 3]> {
    let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    bytes[20..20 + count * 12]
        .chunks_exact(12)
        .map(|chunk| {
            std::array::from_fn(|axis| {
                f32::from_le_bytes(chunk[axis * 4..axis * 4 + 4].try_into().unwrap())
            })
        })
        .collect()
}

fn transform_point(matrix: &[f64; 16], point: [f32; 3]) -> [f64; 3] {
    let point = point.map(f64::from);
    std::array::from_fn(|axis| {
        point[0] * matrix[axis]
            + point[1] * matrix[4 + axis]
            + point[2] * matrix[8 + axis]
            + matrix[12 + axis]
    })
}

fn world_transform(
    stage: &openusd::usd::Stage,
    path: &str,
    time: Option<f64>,
) -> Option<[f64; 16]> {
    let mut current = Some(stage.prim(sdf::try_into_path(path).unwrap()).unwrap());
    let mut chain = Vec::new();
    while let Some(prim) = current {
        current = prim.parent();
        let reset = matches!(
            prim.attribute("xformOpOrder")
                .get_at::<Value>(time.map(TimeCode::new))
                .unwrap(),
            Some(Value::TokenVec(ops))
                if ops.iter().any(|op| op.as_str() == "!resetXformStack!")
        );
        chain.push(prim);
        if reset {
            break;
        }
    }
    let mut accumulated = gf::Matrix4d::IDENTITY;
    for prim in chain.iter().rev() {
        accumulated = local_transform(prim, time).ok()?? * accumulated;
    }
    Some(accumulated.0)
}

fn extend_bounds(bounds: &mut Option<([f64; 3], [f64; 3])>, point: [f64; 3]) {
    match bounds {
        None => *bounds = Some((point, point)),
        Some((min, max)) => {
            for axis in 0..3 {
                min[axis] = min[axis].min(point[axis]);
                max[axis] = max[axis].max(point[axis]);
            }
        }
    }
}

fn print_bounds(label: &str, bounds: &Option<([f64; 3], [f64; 3])>) {
    let (min, max) = bounds.unwrap();
    println!("{label} min={} max={}", bits64(&min), bits64(&max));
}

fn main() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../assets/full_assets/CarbonFrameBike/CarbonFrameBike.usdz");
    let (stage, info) = open_stage(&path).unwrap();
    let query_time = std::env::var("BIKE_TIME")
        .ok()
        .map(|value| value.parse::<f64>().unwrap())
        .unwrap_or(info.start_time_code);
    let time = Some(query_time);
    println!("QUERY_TIME {:016x}", query_time.to_bits());
    println!(
        "STAGE up={} start={:016x} end={:016x} tcps={:016x} errors={}",
        info.up_axis,
        info.start_time_code.to_bits(),
        info.end_time_code.to_bits(),
        info.time_codes_per_second.to_bits(),
        info.composition_errors.len()
    );

    let tree = serialize_tree(&stage).unwrap();
    let mut paths = BTreeSet::new();
    tree_paths(&tree, &mut paths);
    let mut worlds = BTreeMap::new();
    for path in paths {
        let prim = stage.prim(sdf::try_into_path(&path).unwrap()).unwrap();
        let local = local_transform(&prim, time).unwrap().map(|matrix| matrix.0);
        let world = world_transform(&stage, &path, time);
        println!(
            "PRIM {path} local={} world={}",
            local.map_or("none".into(), |m| bits64(&m)),
            world.map_or("none".into(), |m| bits64(&m))
        );
        worlds.insert(path, world);
    }

    let manifest = serialize_render_manifest(&stage, time).unwrap();
    let mut nodes = Vec::new();
    manifest_nodes(&manifest, &mut nodes);
    nodes.sort_by(|a, b| a.path.cmp(&b.path));
    let mut geometry_paths = BTreeSet::new();
    for node in nodes {
        println!(
            "MANIFEST {} type={} geometry={} visible={} transform={} instances={}",
            node.path,
            node.type_name,
            node.has_geometry,
            node.visible,
            bits64(&node.transform),
            node.instances.len()
        );
        for (index, instance) in node.instances.iter().enumerate() {
            println!("INSTANCE {} {} {}", node.path, index, bits64(instance));
        }
        if node.has_geometry {
            geometry_paths.insert(node.path.clone());
        }
    }

    let mut raw_bounds = None;
    let mut upright_bounds = None;
    for path in geometry_paths {
        let prim = stage.prim(sdf::try_into_path(&path).unwrap()).unwrap();
        let mesh = tessellate_prim(&prim, time).unwrap().unwrap();
        let bytes = pack_geometry(&mesh);
        let vertices = positions(&bytes);
        let index_count = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        let flags = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
        println!(
            "GEOMETRY {path} bytes={} hash={:016x} vertices={} indices={} flags={}",
            bytes.len(),
            fnv1a(&bytes),
            vertices.len(),
            index_count,
            flags
        );
        for index in [
            0,
            1,
            2,
            vertices.len().saturating_sub(3),
            vertices.len().saturating_sub(2),
            vertices.len().saturating_sub(1),
        ] {
            if let Some(vertex) = vertices.get(index) {
                println!("VERTEX {path} {index} {}", bits32(vertex));
            }
        }
        let world = worlds.get(&path).and_then(|world| *world).unwrap();
        for vertex in vertices {
            let point = transform_point(&world, vertex);
            extend_bounds(&mut raw_bounds, point);
            let upright = if info.up_axis == "Z" {
                [point[0], point[2], -point[1]]
            } else {
                point
            };
            extend_bounds(&mut upright_bounds, upright);
        }
    }
    print_bounds("SCENE_RAW_BBOX", &raw_bounds);
    print_bounds("SCENE_UPRIGHT_BBOX", &upright_bounds);
    let (min, max) = upright_bounds.unwrap();
    let center: [f64; 3] = std::array::from_fn(|axis| (min[axis] + max[axis]) / 2.0);
    println!("SCENE_CENTER {}", bits64(&center));
    let upright_rotation = if info.up_axis == "Z" {
        -std::f64::consts::FRAC_PI_2
    } else {
        0.0
    };
    println!("UPRIGHT_ROTATION_X {:016x}", upright_rotation.to_bits());
    let session_path = stage
        .session_layer()
        .and_then(|layer| layer.resolved_path().map(PathBuf::from));
    drop(stage);
    if let Some(path) = session_path {
        std::fs::remove_file(path).unwrap();
    }
}
