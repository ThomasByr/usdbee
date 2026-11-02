use std::any::Any;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use openusd::ar::DefaultResolver;
use openusd::gf;
use openusd::sdf;
use openusd::usd::{InitialLoadSet, PrimPredicate, SchemaBase, Stage, TimeCode};
use openusd_schemas::geom::{
    Imageable, ImageableExt, PointInstancer, PointInstancerSchema, Purpose, Visibility,
};
use openusd_schemas::shade::{Material, MaterialBindingAPI};
use serde::{Deserialize, Serialize};

use crate::fetcher::get_usdbee_cache_dir;
use crate::materials::{material_info, MaterialInfo};
use crate::tessellation::{pack_geometry, tessellate_prim, MeshData};
use crate::values::{local_transform, serialize_details, PrimDetails};

pub enum StageRequest {
    Open {
        path: PathBuf,
        reply: mpsc::Sender<Result<StageInfo, String>>,
    },
    GetTree {
        reply: mpsc::Sender<Result<Vec<PrimNode>, String>>,
    },
    GetDetails {
        path: String,
        time: Option<f64>,
        reply: mpsc::Sender<Result<PrimDetails, String>>,
    },
    GetManifest {
        time: Option<f64>,
        reply: mpsc::Sender<Result<Vec<RenderNode>, String>>,
    },
    GetGeometry {
        path: String,
        time: Option<f64>,
        reply: mpsc::Sender<Result<Vec<u8>, String>>,
    },
    GetMaterial {
        path: String,
        reply: mpsc::Sender<Result<MaterialInfo, String>>,
    },
}

pub struct StageState {
    pub sender: mpsc::Sender<StageRequest>,
}

pub fn spawn_stage_owner() -> StageState {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut current_stage = None;
        let mut mesh_cache = MeshCache::new();
        while let Ok(request) = receiver.recv() {
            match request {
                StageRequest::Open { path, reply } => {
                    let response = catch_unwind(AssertUnwindSafe(|| {
                        let (stage, info) = open_stage(&path)?;
                        current_stage = Some(stage);
                        Ok(info)
                    }))
                    .unwrap_or_else(panic_reply);
                    mesh_cache.clear();
                    let _ = reply.send(response);
                }
                StageRequest::GetTree { reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| serialize_tree(stage)))
                            .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetDetails { path, time, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => {
                            catch_unwind(AssertUnwindSafe(|| serialize_details(stage, &path, time)))
                                .unwrap_or_else(panic_reply)
                        }
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetManifest { time, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            serialize_render_manifest(stage, time)
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetGeometry { path, time, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            geometry_bytes(stage, &mut mesh_cache, &path, time)
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetMaterial { path, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            // Synthetic prototype children resolve their
                            // material through the real prototype prim.
                            let resolved = resolve_render_path(stage, &path)?.to_string();
                            material_info(stage, &resolved)
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
            }
        }
    });
    StageState { sender }
}

fn panic_reply<T>(payload: Box<dyn Any + Send>) -> Result<T, String> {
    let message = payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_string());
    Err(format!("internal stage error: {}", message))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageInfo {
    pub root_layer: String,
    pub time_codes_per_second: f64,
    pub start_time_code: f64,
    pub end_time_code: f64,
    pub composition_errors: Vec<String>,
    // "Y" or "Z"; anything the stage authors or we fail to read falls
    // back to "Y", the USD spec default (fail-soft with a warn).
    #[serde(default)]
    pub up_axis: String,
}

fn normalized_up_axis(token: &str) -> String {
    if token == "Y" || token == "Z" {
        token.to_owned()
    } else {
        eprintln!(
            "unrecognized stage upAxis '{}' — treating as USD default \"Y\"",
            token
        );
        "Y".to_owned()
    }
}

// Stage-level `upAxis` metadata; tokens arrive as `Value::Token` (usda
// authors) or `Value::String` (binary/programmatic authors).
fn stage_up_axis(stage: &Stage) -> String {
    match stage.stage_metadata("upAxis") {
        Ok(Some(sdf::Value::Token(token))) => normalized_up_axis(token.as_str()),
        Ok(Some(sdf::Value::String(value))) => normalized_up_axis(&value),
        Ok(Some(other)) => {
            eprintln!(
                "unexpected upAxis value type ({:?}) — treating as USD default \"Y\"",
                other
            );
            "Y".to_owned()
        }
        Ok(None) => "Y".to_owned(),
        Err(e) => {
            eprintln!(
                "failed to read stage upAxis ({}) — treating as USD default \"Y\"",
                e
            );
            "Y".to_owned()
        }
    }
}

pub fn open_stage(path: &Path) -> Result<(Stage, StageInfo), String> {
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("USD stage path is not valid UTF-8: {}", path.display()))?;
    let cache_dir = get_usdbee_cache_dir();
    let resolver =
        DefaultResolver::with_search_paths([cache_dir.clone(), cache_dir.join("extracted")]);
    let stage = Stage::builder()
        // Registers every enabled openusd-schemas family so `is_a`/
        // `from_prim` detection and schema-declared fallbacks resolve
        // (Task 3; Mesh topology declares no fallback, so the
        // missing-topology Err semantics of tessellation are unchanged).
        .schema_registry(openusd_schemas::schema_registry())
        .resolver(resolver)
        .load(InitialLoadSet::LoadAll)
        .open(path_str)
        .map_err(|e| format!("Failed to open USD stage '{}': {}", path.display(), e))?;
    stage
        .traverse(PrimPredicate::ALL, |_| {})
        .map_err(|e| format!("Failed to compose USD stage '{}': {}", path.display(), e))?;

    let info = StageInfo {
        root_layer: stage.root_layer().identifier().to_owned(),
        time_codes_per_second: stage.time_codes_per_second(),
        start_time_code: stage.start_time_code(),
        end_time_code: stage.end_time_code(),
        composition_errors: stage
            .composition_errors()
            .into_iter()
            .map(|e| e.to_string())
            .collect(),
        up_axis: stage_up_axis(&stage),
    };

    Ok((stage, info))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PrimNode {
    pub path: String,
    pub name: String,
    pub type_name: String,
    pub kind: String,
    pub is_active: bool,
    pub is_instance: bool,
    pub is_abstract: bool,
    pub children: Vec<PrimNode>,
}

// Chosen predicate, recorded per the brief: openusd `PrimPredicate::DEFAULT`
// rejects prims with the ABSTRACT status bit (class specifiers, spec 11.3);
// we mirror just that rejection here — `Prim::children()` returns every
// composed child, and we skip abstract ones. Inactive prims are kept with
// `is_active: false` (the flag exists for the frontend) and naturally have no
// composed children. Instance prims are kept but not descended into:
// `Prim::children()` on an instance lists its instance proxies, which we
// skip — prototype details arrive in Task 4.
pub fn serialize_tree(stage: &Stage) -> Result<Vec<PrimNode>, String> {
    fn children_of(prim: &openusd::usd::Prim) -> Result<Vec<PrimNode>, String> {
        let mut nodes = Vec::new();
        for child in visible_children(prim)? {
            let is_instance = child.is_instance().map_err(stage_err)?;
            let node = PrimNode {
                path: child.path().to_string(),
                name: child.path().name().unwrap_or_default().to_string(),
                type_name: child
                    .type_name()
                    .map_err(stage_err)?
                    .map(|t| t.to_string())
                    .unwrap_or_default(),
                kind: child
                    .kind()
                    .map_err(stage_err)?
                    .map(|t| t.to_string())
                    .unwrap_or_default(),
                is_active: child.is_active().map_err(stage_err)?,
                is_instance,
                is_abstract: false,
                children: if is_instance {
                    Vec::new()
                } else {
                    children_of(&child)?
                },
            };
            nodes.push(node);
        }
        Ok(nodes)
    }

    let pseudo_root = stage
        .prim(sdf::Path::abs_root())
        .map_err(|e| format!("invalid pseudo-root path: {}", e))?;
    children_of(&pseudo_root)
}

/// Composed children of `prim` with the tree predicate applied: abstract
/// (class) prims are excluded. Shared by the Phase 1 tree and the Phase 2
/// render manifest so both walks agree.
fn visible_children(prim: &openusd::usd::Prim) -> Result<Vec<openusd::usd::Prim>, String> {
    let mut children = Vec::new();
    for child in prim.children().map_err(stage_err)? {
        if child.is_abstract().map_err(stage_err)? {
            continue;
        }
        children.push(child);
    }
    Ok(children)
}

fn stage_err(error: openusd::Error) -> String {
    format!("failed to compose prim tree: {}", error)
}

/// One node of the render manifest (Phase 2): the traversal mirrors
/// `serialize_tree` (abstract prims excluded, instance prims are leaves), and
/// `transform` is the prim's local transform at `time` in the same
/// row-major, row-vector convention as `PrimDetails::local_transform`
/// (translation in the last row); identity when the prim authors no
/// evaluable xformOpOrder.
///
/// Task 4 composition rules: prims whose computed purpose (own + inherited,
/// via the schemas `ImageableExt` walk) is `proxy` or `guide` are excluded;
/// `visible` is the computed visibility (an `invisible` opinion on the prim
/// or any imageable ancestor clears it, re-authoring `inherited` stops the
/// walk); geometry nodes (Mesh/BasisCurves/Points) carry their direct
/// `material:binding` target path;
/// PointInstancer nodes carry one synthetic child per prototype with the
/// per-prototype instance matrices (see `prototype_children`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RenderNode {
    pub path: String,
    pub name: String,
    pub type_name: String,
    pub has_geometry: bool,
    pub animated: bool,
    /// The node's OWN geometry-defining attributes have authored time
    /// samples (Task 6 ruling's "own sampled geometry attrs"): a playback
    /// step must refetch this node's geometry. `animated` keeps its
    /// broader meaning (any motion signal, incl. ancestor transforms and
    /// instancer arrays); transform-only animated nodes keep their
    /// load-time geometry, which never changes.
    pub geometry_animated: bool,
    pub material: Option<String>,
    pub instances: Vec<[f64; 16]>,
    pub transform: [f64; 16],
    pub visible: bool,
    pub children: Vec<RenderNode>,
}

/// The synthetic prototype-child path prefix (Task 4 controller ruling):
/// `<instancer>/__proto_<i>` addresses prototype `i`'s geometry.
const PROTO_PREFIX: &str = "__proto_";

/// Purpose/visibility state for one prim, per USD semantics (schema
/// `ImageableExt` walks): non-imageable prims are kept visible (their
/// children compute their own inherited state); imageable prims are
/// excluded when the computed purpose is proxy/guide, and their computed
/// visibility (inherited down, stoppable by re-authoring) sets `visible`.
enum Renderable {
    Keep { visible: bool },
    Exclude,
}

fn renderable_state(prim: &openusd::usd::Prim, time: Option<f64>) -> Result<Renderable, String> {
    let Some(imageable) = Imageable::from_prim(prim.clone()).map_err(stage_err)? else {
        return Ok(Renderable::Keep { visible: true });
    };
    if matches!(
        imageable.compute_purpose().map_err(stage_err)?,
        Purpose::Proxy | Purpose::Guide
    ) {
        return Ok(Renderable::Exclude);
    }
    let visible = imageable
        .compute_visibility(time.map(TimeCode::new))
        .map_err(stage_err)?
        != Visibility::Invisible;
    Ok(Renderable::Keep { visible })
}

/// The direct `material:binding` target path, the same resolution
/// get_material_data applies for a mesh (the manifest value is
/// informational; the frontend passes the mesh path to get_material_data).
fn direct_material(stage: &Stage, prim: &openusd::usd::Prim) -> Option<String> {
    let resolved: Result<Option<String>, String> = (|| {
        let Some(path) = MaterialBindingAPI::from_prim_unchecked(prim.clone())
            .direct_binding("")
            .map_err(stage_err)?
        else {
            return Ok(None);
        };
        let material = stage
            .prim(path.clone())
            .map_err(|error| format!("invalid material path '{}': {}", path, error))?;
        if !material.is_valid().map_err(stage_err)?
            || Material::from_prim(material).map_err(stage_err)?.is_none()
        {
            return Ok(None);
        }
        Ok(Some(path.to_string()))
    })();
    match resolved {
        Ok(material) => material,
        Err(error) => {
            eprintln!(
                "usdbee: ignoring material binding at {}: {}",
                prim.path(),
                error
            );
            None
        }
    }
}

/// Exact type names the manifest treats as renderable geometry (Task 5:
/// curves tessellate to tubes, points tessellate to point clouds).
fn renders_geometry(type_name: &str) -> bool {
    matches!(type_name, "Mesh" | "BasisCurves" | "Points" | "Sphere")
}

/// One attribute pass over a prim for both animated signals at once:
/// `(moves transform, deforms geometry)` — the manifest walk
/// previously enumerated the composed attribute list twice per prim with
/// time-sample scans over every attribute, which measured as the kitchen
/// manifest's hot spot (2745 nodes × 29 attributes).
/// `renders_geometry` is the prim's type-gated decision: a non-geometry
/// prim's primvars can never animate rendered vertices, so its primvar
/// names skip the (composed, pricey) time-sample query.
/// Geometry deformation covers points/normals/widths and primvars
/// (Task 6 ruling 1a) plus the topology attrs tessellation reads at the
/// requested time (faceVertexCounts/faceVertexIndices/curveVertexCounts); transform motion covers xformOps and, for a
/// PointInstancer, its per-instance arrays. Attributes outside either
/// family skip the time-sample query.
fn samples_scene_motion(
    prim: &openusd::usd::Prim,
    renders_geometry: bool,
) -> Result<(bool, bool), String> {
    let is_instancer = prim
        .type_name()
        .map_err(stage_err)?
        .is_some_and(|token| token == "PointInstancer");
    let mut transform = false;
    let mut geometry = false;
    // authored_property_names (composed authored names, no schema-declared
    // expansion) is the enumeration the manifest walk can afford — measured
    // ~27x cheaper than attributes() on Kitchen_set_instanced, and a
    // schema-declared yet unauthored attribute can never carry time samples.
    for name in prim.authored_property_names().map_err(stage_err)? {
        let name = name.as_str();
        let moves_transform = name.starts_with("xformOp:")
            || (is_instancer
                && matches!(
                    name,
                    "positions" | "orientations" | "scales" | "protoIndices" | "invisibleIds"
                ));
        let deforms_geometry = renders_geometry
            && (matches!(
                name,
                "points"
                    | "normals"
                    | "widths"
                    | "radius"
                    | "faceVertexCounts"
                    | "faceVertexIndices"
                    | "curveVertexCounts"
            ) || name.starts_with("primvars:"));
        if !moves_transform && !deforms_geometry {
            continue;
        }
        if prim.attribute(name).num_time_samples().map_err(stage_err)? == 0 {
            continue;
        }
        if moves_transform {
            transform = true;
        }
        if deforms_geometry {
            geometry = true;
        }
    }
    Ok((transform, geometry))
}

/// One synthetic RenderNode per PointInstancer prototype, in `prototypes`
/// order (controller ruling): the child's path is `<instancer>/__proto_<i>`,
/// its type/geometry/material come from the prototype prim, and its
/// `instances` hold that prototype's instance matrices at `time`. Per the
/// UsdGeomPointInstancer contract (pinned by the schemas doc), an instance
/// transform in the instancer's local space is the prototype root's local
/// xform, then scale, then orientation, then position — most local first —
/// so in the row-vector convention: proto_xform * S * R * T. The instancer
/// node's own `transform` carries the instancer's local xform, which the
/// frontend applies least locally.
fn prototype_children(
    stage: &Stage,
    prim: &openusd::usd::Prim,
    time: Option<f64>,
    instancer_moves: bool,
    prototype_memo: &mut PrototypeMemo,
) -> Result<Vec<RenderNode>, String> {
    let instancer = PointInstancer::from_prim_unchecked(prim.clone());
    let time_code = time.map(TimeCode::new);
    let prototypes = instancer
        .prototypes_rel()
        .forwarded_targets()
        .map_err(stage_err)?;
    let proto_indices = instancer
        .proto_indices_at(time_code)
        .map_err(stage_err)?
        .unwrap_or_default();
    let positions = instancer
        .positions_at(time_code)
        .map_err(stage_err)?
        .unwrap_or_default();
    let orientations: Vec<gf::Quatf> = instancer
        .prim()
        .attribute("orientations")
        // shortcut: the generated `orientations_at` decodes Vec<Quath>
        // (half) though the schema declares quatf[], so authored quatf
        // arrays read None through it — read the raw attribute instead
        .get_at::<Vec<gf::Quatf>>(time_code)
        .map_err(stage_err)?
        .unwrap_or_default();
    let scales = instancer
        .scales_at(time_code)
        .map_err(stage_err)?
        .unwrap_or_default();
    let invisible_ids = instancer
        .invisible_ids_at(time_code)
        .map_err(stage_err)?
        .unwrap_or_default();

    let mut children = Vec::new();
    for (index, prototype_path) in prototypes.iter().enumerate() {
        let prototype = stage
            .prim(prototype_path.clone())
            .map_err(|e| format!("invalid prototype path '{}': {}", prototype_path, e))?;
        if !prototype.is_valid().map_err(stage_err)? {
            continue;
        }
        // An excluded prototype ROOT still emits its synthetic node (with
        // its own geometry suppressed): descendants traverse with their own
        // computed purpose deciding, mirroring render_children's Exclude
        // arm for ordinary parents. The root's geometry must not draw, so
        // has_geometry clears when the root is excluded.
        let (excluded, visible) = match renderable_state(&prototype, time)? {
            Renderable::Exclude => (true, true),
            Renderable::Keep { visible } => (false, visible),
        };
        let type_name = prototype
            .type_name()
            .map_err(stage_err)?
            .map(|token| token.to_string())
            .unwrap_or_default();
        let proto_xform = local_transform(&prototype, time)?.unwrap_or(gf::Matrix4d::IDENTITY);
        // The prototype root's own xform is folded into every
        // instance matrix, so sampled proto xformOps animate the
        // child as much as the instancer's own arrays do.
        let proto_renders_geometry = renders_geometry(&type_name);
        let (proto_moves, proto_deforms) =
            samples_scene_motion(&prototype, proto_renders_geometry)?;
        let animated = instancer_moves || proto_moves || (proto_renders_geometry && proto_deforms);
        // The synthetic node fetches the prototype ROOT's geometry (the
        // one cache entry keyed by its resolved path), so only the root's
        // own sampled geometry attrs count here — its descendants carry
        // their own per-node flags from the walked subtree below.
        let geometry_animated = proto_renders_geometry && proto_deforms;
        let mut instances = Vec::new();
        for (i, &proto_index) in proto_indices.iter().enumerate() {
            if proto_index < 0
                || proto_index as usize != index
                || invisible_ids.contains(&(i as i64))
            {
                continue;
            }
            let scale = scales
                .get(i)
                .map(|s| gf::Matrix4d::scale([s.x as f64, s.y as f64, s.z as f64]))
                .unwrap_or(gf::Matrix4d::IDENTITY);
            let rotation = orientations
                .get(i)
                .map(|q| gf::Matrix4d::from_quat([q.w as f64, q.x as f64, q.y as f64, q.z as f64]))
                .unwrap_or(gf::Matrix4d::IDENTITY);
            let translation = positions
                .get(i)
                .map(|p| gf::Matrix4d::translation([p.x as f64, p.y as f64, p.z as f64]))
                .unwrap_or(gf::Matrix4d::IDENTITY);
            instances.push((proto_xform * scale * rotation * translation).0);
        }
        if instances.is_empty() {
            continue;
        }
        let synthetic_path = format!("{}/{}{}", prim.path(), PROTO_PREFIX, index);
        let mut prototype_children =
            render_children(stage, &prototype, time, animated, prototype_memo)?;
        rebase_render_paths(
            &mut prototype_children,
            prototype.path(),
            &sdf::try_into_path(synthetic_path.as_str())
                .map_err(|e| format!("invalid synthetic prototype path: {}", e))?,
        )?;
        children.push(RenderNode {
            path: synthetic_path,
            name: format!("{}{}", PROTO_PREFIX, index),
            material: direct_material(stage, &prototype),
            instances,
            // The instance matrices are already in instancer-local
            // space; the prototype's own xform is folded into them.
            transform: gf::Matrix4d::IDENTITY.0,
            visible,
            has_geometry: renders_geometry(&type_name) && !excluded,
            type_name,
            animated,
            geometry_animated,
            children: prototype_children,
        });
    }
    Ok(children)
}

fn rebase_render_paths(
    nodes: &mut [RenderNode],
    old_prefix: &sdf::Path,
    new_prefix: &sdf::Path,
) -> Result<(), String> {
    for node in nodes {
        let path = sdf::try_into_path(node.path.as_str())
            .map_err(|e| format!("invalid render path '{}': {}", node.path, e))?;
        node.path = path
            .replace_prefix(old_prefix, new_prefix)
            .ok_or_else(|| format!("render path '{}' is outside {}", node.path, old_prefix))?
            .to_string();
        rebase_render_paths(&mut node.children, old_prefix, new_prefix)?;
    }
    Ok(())
}

/// Rendered prototype subtrees memoized during one manifest walk, keyed by
/// (prototype path, ancestor-moves): identical compositions share one
/// prototype, so the tree is walked once and cloned per instance. The
/// ancestor-moves variant of the animated flag keeps the two states apart.
type PrototypeMemo = HashMap<(sdf::Path, bool), Vec<RenderNode>>;

fn native_prototype_children(
    stage: &Stage,
    instance: &openusd::usd::Prim,
    time: Option<f64>,
    ancestor_moves: bool,
    prototype_memo: &mut PrototypeMemo,
) -> Result<Vec<RenderNode>, String> {
    let Some(prototype_path) = instance.prototype().map_err(stage_err)? else {
        return Ok(Vec::new());
    };
    // The prototype subtree is identical for every instance sharing one
    // prototype (pcp mints the prototype exactly when compositions agree),
    // so its rendered tree is walked once per (prototype, ancestor-moves)
    // and cloned per instance — only the path rebase differs.
    let memo_key = (prototype_path.clone(), ancestor_moves);
    let mut raw = match prototype_memo.get(&memo_key) {
        Some(children) => children.clone(),
        None => {
            let prototype = stage
                .prim(memo_key.0.clone())
                .map_err(|e| format!("invalid native prototype for {}: {}", instance.path(), e))?;
            let moves = ancestor_moves || samples_scene_motion(&prototype, false)?.0;
            let children = render_children(stage, &prototype, time, moves, prototype_memo)?;
            prototype_memo.insert(memo_key.clone(), children.clone());
            children
        }
    };
    rebase_render_paths(&mut raw, &prototype_path, instance.path())?;
    Ok(raw)
}

fn render_node_children(
    stage: &Stage,
    prim: &openusd::usd::Prim,
    type_name: &str,
    is_instance: bool,
    time: Option<f64>,
    ancestor_moves: bool,
    prototype_memo: &mut PrototypeMemo,
) -> Result<Vec<RenderNode>, String> {
    if type_name == "PointInstancer" {
        prototype_children(stage, prim, time, ancestor_moves, prototype_memo)
    } else if is_instance {
        native_prototype_children(stage, prim, time, ancestor_moves, prototype_memo)
    } else {
        render_children(stage, prim, time, ancestor_moves, prototype_memo)
    }
}

fn render_children(
    stage: &Stage,
    prim: &openusd::usd::Prim,
    time: Option<f64>,
    ancestor_moves: bool,
    prototype_memo: &mut PrototypeMemo,
) -> Result<Vec<RenderNode>, String> {
    let mut nodes = Vec::new();
    for child in visible_children(prim)? {
        let is_instance = child.is_instance().map_err(stage_err)?;
        let type_name = child
            .type_name()
            .map_err(stage_err)?
            .map(|t| t.to_string())
            .unwrap_or_default();
        let renders = renders_geometry(&type_name);
        let (self_moves, self_deforms) = samples_scene_motion(&child, renders)?;
        let deforms = renders && self_deforms;
        let moves = ancestor_moves || self_moves;
        let transform = local_transform(&child, time)?.unwrap_or(gf::Matrix4d::IDENTITY);
        let visible = match renderable_state(&child, time)? {
            Renderable::Exclude => {
                let mut descendants =
                    render_node_children(stage, &child, &type_name, is_instance, time, moves, prototype_memo)?;
                for descendant in &mut descendants {
                    descendant.transform = (transform * gf::Matrix4d(descendant.transform)).0;
                }
                nodes.extend(descendants);
                continue;
            }
            Renderable::Keep { visible } => visible,
        };
        let children =
            render_node_children(stage, &child, &type_name, is_instance, time, moves, prototype_memo)?;
        let node = RenderNode {
            material: if renders_geometry(&type_name) {
                direct_material(stage, &child)
            } else {
                None
            },
            path: child.path().to_string(),
            name: child.path().name().unwrap_or_default().to_string(),
            has_geometry: renders_geometry(&type_name),
            type_name,
            animated: deforms || moves,
            geometry_animated: deforms,
            instances: Vec::new(),
            transform: transform.0,
            visible,
            children,
        };
        nodes.push(node);
    }
    Ok(nodes)
}

pub fn serialize_render_manifest(
    stage: &Stage,
    time: Option<f64>,
) -> Result<Vec<RenderNode>, String> {
    let pseudo_root = stage
        .prim(sdf::Path::abs_root())
        .map_err(|e| format!("invalid pseudo-root path: {}", e))?;
    let mut prototype_memo = PrototypeMemo::new();
    render_children(stage, &pseudo_root, time, false, &mut prototype_memo)
}

/// Tessellation cache owned by the stage-owner thread: (prim path, time as
/// queried) -> mesh. `None` and `Some(t)` are distinct keys.
pub struct MeshCache {
    entries: HashMap<(String, Option<u64>), Arc<MeshData>>,
}

impl Default for MeshCache {
    fn default() -> Self {
        Self::new()
    }
}

// `Option<f64>` is not `Hash` (and NaN keys would be ambiguous), so the
// public API takes the queried `Option<f64>` and stores its bits.
fn cache_key(key: (String, Option<f64>)) -> (String, Option<u64>) {
    (key.0, key.1.map(f64::to_bits))
}

impl MeshCache {
    const CAP: usize = 256;

    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    pub fn get(&self, key: &(String, Option<f64>)) -> Option<Arc<MeshData>> {
        self.entries.get(&cache_key(key.clone())).cloned()
    }

    pub fn insert(&mut self, key: (String, Option<f64>), mesh: Arc<MeshData>) {
        // shortcut: primitive eviction — a full clear at the cap; measure real
        // scenes before anything cleverer
        if !self.entries.contains_key(&cache_key(key.clone())) && self.entries.len() >= Self::CAP {
            self.entries.clear();
        }
        self.entries.insert(cache_key(key), mesh);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Rewrite a frontend-requested prim path to the prim the request actually
/// reads: `<instancer>/__proto_<i>` resolves to prototype `i`'s real prim
/// path (clamped to the prototypes array with a readable error), every
/// other path passes through untouched. Shared by the GetGeometry and
/// GetMaterial arms so prototype children fetch both through their
/// synthetic paths.
fn resolve_render_path(stage: &Stage, path: &str) -> Result<sdf::Path, String> {
    let parsed =
        sdf::try_into_path(path).map_err(|e| format!("invalid prim path '{}': {}", path, e))?;
    let mut resolved = parsed;
    let mut ancestor = resolved.clone();
    loop {
        if let Some((index, parent)) = synthetic_prototype(&ancestor)? {
            let parent_prim = stage
                .prim(parent.clone())
                .map_err(|e| format!("invalid prim path '{}': {}", parent, e))?;
            if !parent_prim.is_valid().map_err(stage_err)? {
                return Err(format!("prim not found: {}", parent));
            }
            let type_name = parent_prim
                .type_name()
                .map_err(stage_err)?
                .map(|token| token.to_string())
                .unwrap_or_default();
            if type_name != "PointInstancer" {
                return Err(format!(
                    "invalid prototype path {}: {} is not a PointInstancer",
                    path, parent
                ));
            }
            let prototypes = PointInstancer::from_prim_unchecked(parent_prim)
                .prototypes_rel()
                .forwarded_targets()
                .map_err(stage_err)?;
            let prototype = prototypes.get(index).cloned().ok_or_else(|| {
                format!(
                    "prototype index {} out of range: {} has {} prototypes",
                    index,
                    parent,
                    prototypes.len()
                )
            })?;
            let suffix = resolved
                .as_str()
                .strip_prefix(ancestor.as_str())
                .ok_or_else(|| format!("invalid synthetic prototype path: {}", path))?;
            resolved = sdf::try_into_path(format!("{}{}", prototype, suffix))
                .map_err(|e| format!("invalid resolved prototype path '{}': {}", path, e))?;
            break;
        }
        let Some(parent) = ancestor.parent() else {
            break;
        };
        ancestor = parent;
    }

    let prim = stage
        .prim(resolved.clone())
        .map_err(|e| format!("invalid prim path '{}': {}", path, e))?;
    if prim.is_instance_proxy().map_err(stage_err)? {
        if let Some(prototype_prim) = prim.prim_in_prototype().map_err(stage_err)? {
            return Ok(prototype_prim.path().clone());
        }
    }
    Ok(resolved)
}

/// The prototype index and instancer path when `path` is a synthetic
/// `<instancer>/__proto_<i>` child, `Ok(None)` for every other path.
fn synthetic_prototype(path: &sdf::Path) -> Result<Option<(usize, sdf::Path)>, String> {
    let Some(segment) = path.name() else {
        return Ok(None);
    };
    let Some(suffix) = segment.strip_prefix(PROTO_PREFIX) else {
        return Ok(None);
    };
    let index: usize = suffix.parse().map_err(|_| {
        format!(
            "invalid prototype path {}: expected {}<index>",
            path, PROTO_PREFIX
        )
    })?;
    match path.parent() {
        Some(parent) => Ok(Some((index, parent))),
        None => Ok(None),
    }
}

/// Packed geometry bytes for one prim, tessellating on demand and caching the
/// result (keyed by the resolved path, so prototype children share one
/// tessellation with the prototype prim). Missing prims and non-geometry
/// prims (those outside `renders_geometry`) as well
/// are readable per-call errors; a failed prim never poisons the cache.
fn geometry_bytes(
    stage: &Stage,
    cache: &mut MeshCache,
    path: &str,
    time: Option<f64>,
) -> Result<Vec<u8>, String> {
    let prim_path = resolve_render_path(stage, path)?;
    let key = (prim_path.to_string(), time);
    if let Some(mesh) = cache.get(&key) {
        return Ok(pack_geometry(&mesh));
    }
    let prim = stage
        .prim(prim_path)
        .map_err(|e| format!("invalid prim path '{}': {}", path, e))?;
    if !prim.is_valid().map_err(stage_err)? {
        return Err(format!("prim not found: {}", path));
    }
    match tessellate_prim(&prim, time)? {
        Some(mesh) => {
            let mesh = Arc::new(mesh);
            cache.insert(key, mesh.clone());
            Ok(pack_geometry(&mesh))
        }
        None => Err(format!("no geometry at {}", path)),
    }
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn get_stage_tree(state: tauri::State<'_, StageState>) -> Result<Vec<PrimNode>, String> {
    request_stage_tree(&state.sender)
}

pub fn request_stage_tree(sender: &mpsc::Sender<StageRequest>) -> Result<Vec<PrimNode>, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetTree { reply })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn get_prim_details(
    path: String,
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<PrimDetails, String> {
    request_stage_details(&state.sender, &path, time)
}

pub fn request_stage_details(
    sender: &mpsc::Sender<StageRequest>,
    path: &str,
    time: Option<f64>,
) -> Result<PrimDetails, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetDetails {
            path: path.to_string(),
            time,
            reply,
        })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn get_scene_manifest(
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<Vec<RenderNode>, String> {
    request_scene_manifest(&state.sender, time)
}

pub fn request_scene_manifest(
    sender: &mpsc::Sender<StageRequest>,
    time: Option<f64>,
) -> Result<Vec<RenderNode>, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetManifest { time, reply })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
// The packed bytes travel as a raw `tauri::ipc::Response`, which Tauri v2
// delivers to the frontend `invoke` as an ArrayBuffer.
#[tauri::command]
pub async fn get_geometry_data(
    path: String,
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<tauri::ipc::Response, String> {
    request_geometry_data(&state.sender, &path, time).map(tauri::ipc::Response::new)
}

pub fn request_geometry_data(
    sender: &mpsc::Sender<StageRequest>,
    path: &str,
    time: Option<f64>,
) -> Result<Vec<u8>, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetGeometry {
            path: path.to_string(),
            time,
            reply,
        })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Material binding data for one prim (Task 3): the prim may be the mesh
// (its `material:binding` is resolved inside) or the material itself.
#[tauri::command]
pub async fn get_material_data(
    path: String,
    state: tauri::State<'_, StageState>,
) -> Result<MaterialInfo, String> {
    request_material_data(&state.sender, &path)
}

pub fn request_material_data(
    sender: &mpsc::Sender<StageRequest>,
    path: &str,
) -> Result<MaterialInfo, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetMaterial {
            path: path.to_string(),
            reply,
        })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn open_usd_path(
    path: String,
    state: tauri::State<'_, StageState>,
) -> Result<StageInfo, String> {
    request_stage_open(&PathBuf::from(path), &state.sender)
}

pub fn request_stage_open(
    path: &Path,
    sender: &mpsc::Sender<StageRequest>,
) -> Result<StageInfo, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::Open {
            path: path.to_path_buf(),
            reply,
        })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}
