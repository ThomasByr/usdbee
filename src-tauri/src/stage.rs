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
use openusd::usd::{InitialLoadSet, PrimPredicate, Stage};
use serde::{Deserialize, Serialize};

use crate::fetcher::get_usdbee_cache_dir;
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
    // Stub until Task 3: the arm answers `Ok(None)` so the enum shape is
    // already final.
    GetMaterial {
        path: String,
        reply: mpsc::Sender<Result<Option<serde_json::Value>, String>>,
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
                StageRequest::GetMaterial { path: _, reply } => {
                    let _ = reply.send(Ok(None));
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
}

pub fn open_stage(path: &Path) -> Result<(Stage, StageInfo), String> {
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("USD stage path is not valid UTF-8: {}", path.display()))?;
    let cache_dir = get_usdbee_cache_dir();
    let resolver =
        DefaultResolver::with_search_paths([cache_dir.clone(), cache_dir.join("extracted")]);
    let stage = Stage::builder()
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

/// One node of the render manifest (Phase 2 scaffold): the traversal mirrors
/// `serialize_tree` (abstract prims excluded, instance prims are leaves), and
/// `transform` is the prim's local transform at `time` in the same
/// row-major, row-vector convention as `PrimDetails::local_transform`
/// (translation in the last row); identity when the prim authors no
/// evaluable xformOpOrder. Task 2 populates path/name/type_name/
/// has_geometry/transform/children; `instances` is empty, `visible` is true
/// and `animated` is false until Tasks 4/6. `has_geometry` is `type_name ==
/// "Mesh"` for now (Task 4 refines the walk and purpose filtering).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RenderNode {
    pub path: String,
    pub name: String,
    pub type_name: String,
    pub has_geometry: bool,
    pub animated: bool,
    pub material: Option<String>,
    pub instances: Vec<[f64; 16]>,
    pub transform: [f64; 16],
    pub visible: bool,
    pub children: Vec<RenderNode>,
}

pub fn serialize_render_manifest(
    stage: &Stage,
    time: Option<f64>,
) -> Result<Vec<RenderNode>, String> {
    fn children_of(
        prim: &openusd::usd::Prim,
        time: Option<f64>,
    ) -> Result<Vec<RenderNode>, String> {
        let mut nodes = Vec::new();
        for child in visible_children(prim)? {
            let is_instance = child.is_instance().map_err(stage_err)?;
            let type_name = child
                .type_name()
                .map_err(stage_err)?
                .map(|t| t.to_string())
                .unwrap_or_default();
            let node = RenderNode {
                path: child.path().to_string(),
                name: child.path().name().unwrap_or_default().to_string(),
                has_geometry: type_name == "Mesh",
                type_name,
                animated: false,
                material: None,
                instances: Vec::new(),
                transform: local_transform(&child, time)?
                    .map(|matrix| matrix.0)
                    .unwrap_or(gf::Matrix4d::IDENTITY.0),
                visible: true,
                children: if is_instance {
                    Vec::new()
                } else {
                    children_of(&child, time)?
                },
            };
            nodes.push(node);
        }
        Ok(nodes)
    }

    let pseudo_root = stage
        .prim(sdf::Path::abs_root())
        .map_err(|e| format!("invalid pseudo-root path: {}", e))?;
    children_of(&pseudo_root, time)
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

/// Packed geometry bytes for one prim, tessellating on demand and caching the
/// result. Missing prims and non-Mesh prims are readable per-call errors; a
/// failed prim never poisons the cache.
fn geometry_bytes(
    stage: &Stage,
    cache: &mut MeshCache,
    path: &str,
    time: Option<f64>,
) -> Result<Vec<u8>, String> {
    let key = (path.to_string(), time);
    if let Some(mesh) = cache.get(&key) {
        return Ok(pack_geometry(&mesh));
    }
    let prim_path =
        sdf::try_into_path(path).map_err(|e| format!("invalid prim path '{}': {}", path, e))?;
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

// Material binding data is a Task 3 stub: the command exists so Task 4 can
// wire it, and always resolves `None` for now.
#[tauri::command]
pub async fn get_material_data(
    path: String,
    state: tauri::State<'_, StageState>,
) -> Result<Option<serde_json::Value>, String> {
    let (reply, response) = mpsc::channel();
    state
        .sender
        .send(StageRequest::GetMaterial { path, reply })
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
