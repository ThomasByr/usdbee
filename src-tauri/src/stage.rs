use std::any::Any;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

use openusd::ar::DefaultResolver;
use openusd::gf;
use openusd::sdf::{self, ValueTypeName};
use openusd::usd::{
    ApplyMode, Attribute, Diff, EditTarget, EditTargetArc, InitialLoadSet, PrimPredicate,
    ReplayStage, SchemaBase, Stage, StageAuthoringError, TimeCode, UndoStage,
};
use openusd_schemas::geom::{
    Imageable, ImageableExt, PointInstancer, PointInstancerSchema, Purpose, Visibility,
};
use openusd_schemas::shade::nodes::{PreviewSurface, UVTexture};
use openusd_schemas::shade::{Connectable, Material, MaterialBindingAPI};
use serde::{Deserialize, Serialize};

use crate::fetcher::get_usdbee_cache_dir;
use crate::materials::{material_info, MaterialInfo};
use crate::parser::{dependency_scan_from_stage, DependencyScan};
use crate::skinning::{skel_joint_transforms_vary, SkelAnimMemo};
use crate::tessellation::{pack_geometry, tessellate_prim};
use crate::values::{
    local_transform, serialize_details, value_payload_to_sdf, PrimDetails, ValuePayload,
};

pub enum StageRequest {
    Open {
        path: PathBuf,
        // usdz origin carried by the caller: the File > Open flow extracts
        // .usdz archives to the cache and opens the extracted .usdc, whose
        // suffix cannot reveal the origin. Plain path opens pass false; the
        // Open arm still derives direct .usdz opens from the suffix.
        is_usdz: bool,
        // Original archive for collision checks; direct opens can derive it
        // from `path`, while the extraction flow supplies it explicitly.
        source_usdz: Option<PathBuf>,
        // The dialog flow's extraction dir: owned by this stage for
        // cleanup — the owner thread deletes it (with the session layer
        // file) on Shutdown. Direct opens pass None.
        extraction_dir: Option<PathBuf>,
        reply: mpsc::Sender<Result<StageInfo, String>>,
    },
    GetTree {
        reply: mpsc::Sender<Result<Vec<PrimNode>, String>>,
    },
    // The dependency scan of the open stage: computed against the layers
    // the open already parsed, so the load pays one parse, not two.
    GetDependencies {
        reply: mpsc::Sender<Result<DependencyScan, String>>,
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
    // Time-delta manifest (playback/scrub): ONLY the time-dependent nodes
    // at `time` — sampled xformOps, geometry attrs, visibility or
    // PointInstancer arrays — plus the connector ancestors an in-place
    // update needs. Empty for a static stage; loads and edit refreshes
    // keep the full GetManifest.
    GetAnimatedManifest {
        time: Option<f64>,
        reply: mpsc::Sender<Result<Vec<RenderNode>, String>>,
    },
    // The stage's authored time-sample times (unioned, ascending): the
    // times playback/scrubbing snap to so the exact-f64-keyed MeshCache
    // hits across loop iterations and scrub revisits.
    GetTimeCodes {
        reply: mpsc::Sender<Result<Vec<f64>, String>>,
    },
    GetGeometry {
        path: String,
        time: Option<f64>,
        reply: mpsc::Sender<Result<Vec<u8>, String>>,
    },
    // One channel round trip for many geometry fetches (Phase 2.5 Task 3):
    // per-slot fail-soft (a bad path becomes an error slot), framed by
    // `frame_batch` so the whole batch either arrives complete or errors.
    GetGeometryBatch {
        paths: Vec<String>,
        time: Option<f64>,
        reply: mpsc::Sender<Result<Vec<u8>, String>>,
    },
    // One playback pose in one owner turn: the time-delta manifest as JSON
    // bytes plus the ordered path list and the geometry batch over those
    // paths, framed by `frame_pose`. Two serial invokes cost a dev-mode pose
    // more latency than the backend work; this is the same work, one hop.
    GetAnimatedPose {
        time: Option<f64>,
        reply: mpsc::Sender<Result<Vec<u8>, String>>,
    },
    GetMaterial {
        path: String,
        reply: mpsc::Sender<Result<MaterialInfo, String>>,
    },
    // Batched material fetch (Phase 2 Task 3): the same one-round-trip
    // shape as GetGeometryBatch, with each slot the JSON bytes of
    // MaterialInfo (or the error message) instead of a USDB frame.
    GetMaterialBatch {
        paths: Vec<String>,
        reply: mpsc::Sender<Result<Vec<u8>, String>>,
    },
    SetValue {
        path: String,
        name: String,
        value: ValuePayload,
        // USD time code (frames), never seconds; None = the default value.
        time: Option<f64>,
        reply: mpsc::Sender<Result<(), String>>,
    },
    SetMetadata {
        path: String,
        key: String,
        value: ValuePayload,
        reply: mpsc::Sender<Result<(), String>>,
    },
    SetVariantSelection {
        path: String,
        variant_set: String,
        // None clears the set's selection on the edit target.
        selection: Option<String>,
        reply: mpsc::Sender<Result<(), String>>,
    },
    // None clears the prim's material:binding targets (the material prims
    // under /Looks stay — the arm documents the shortcut).
    SetPrimTexture {
        path: String,
        texture: Option<String>,
        reply: mpsc::Sender<Result<(), String>>,
    },
    GetEditTarget {
        reply: mpsc::Sender<Result<EditTargetInfo, String>>,
    },
    // None = the session layer; Some(identifier) = a layer in this stage.
    SetEditTarget {
        identifier: Option<String>,
        reply: mpsc::Sender<Result<(), String>>,
    },
    ListDirtyLayers {
        reply: mpsc::Sender<Result<Vec<LayerInfo>, String>>,
    },
    // The only command that writes USD content to disk; nothing else in
    // USDBEE ever does. SaveStageAsUsdz below also writes, but a NEW
    // archive from the composed stage — never a layer file.
    SaveLayers {
        requests: Vec<LayerSaveRequest>,
        reply: mpsc::Sender<Result<(), String>>,
    },
    // Save As usdz: repack the composed stage (session edits included) into
    // a NEW .usdz archive. Not a layer save — it does not go through the
    // save_layers rules, does not mark layers clean, and does not emit
    // usd-stage-changed (the open stage's composition is unchanged).
    SaveStageAsUsdz {
        path: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Undo {
        reply: mpsc::Sender<Result<bool, String>>,
    },
    Redo {
        reply: mpsc::Sender<Result<bool, String>>,
    },
    GetUndoState {
        reply: mpsc::Sender<Result<UndoState, String>>,
    },
    // The Task 6 text layer editor: the usda text of one stage layer, the
    // import that replaces a layer's in-memory content (parse first, replace
    // only on success, never touch any file), and the list of every stage
    // layer for the editor's selector.
    ExportLayerText {
        identifier: String,
        reply: mpsc::Sender<Result<String, String>>,
    },
    ImportLayerText {
        identifier: String,
        text: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    ListStageLayers {
        reply: mpsc::Sender<Result<Vec<LayerInfo>, String>>,
    },
    // Close: the owner deletes its session layer file and its extraction
    // dir (the cleanup paths the open recorded), drops the stage, replies,
    // and exits. The map entry is removed by the close_stage caller.
    Shutdown {
        reply: mpsc::Sender<Result<(), String>>,
    },
    // One list_stages entry: the owner reports its own id, root layer and
    // dirty-layer count from its ledger.
    GetSummary {
        reply: mpsc::Sender<Result<StageSummary, String>>,
    },
}

/// Undo/redo availability over IPC (snake_case mirrors in
/// src/lib/stage/types.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoState {
    pub can_undo: bool,
    pub can_redo: bool,
}

/// The undo depth both sides agree on: the UndoStage's own bound (its
/// default capacity) — beyond it the oldest transaction becomes permanent,
/// and the owner journal mirrors the same eviction.
const UNDO_DEPTH: usize = 128;

/// One user mutation as the undo system sees it: the edit-target layer it
/// was authored on, the ReplayStage forward diffs that reproduce it (the
/// redo journal), and the composed prim path it touched (the
/// usd-stage-changed emission on undo/redo — the same path the original
/// mutation arm emitted).
struct MutationEntry {
    layer: String,
    diffs: Vec<Diff>,
    path: String,
    // The mutation was a default-time xform op / order write, so reverting it
    // (undo) or re-applying it (redo) cannot reshape the tree or falsify a
    // sibling skeleton fact — the undo/redo arms keep the warm caches, as the
    // SetValue arm did when it recorded the entry.
    warm_xform: bool,
}

/// Per-layer unsaved-edit bookkeeping: `applied` counts the mutations
/// currently applied to the layer (mutations minus undones, plus redones);
/// `saved` is the applied count at the last save. A layer is dirty exactly
/// when the two differ, which is what makes undo restore dirty state
/// coherently: undoing back to the saved content cleans the layer, undoing
/// past the save point re-dirties it. Entries persist while clean (the
/// counts are still needed for later undos).
struct LayerLedger {
    entries: Vec<LayerCounts>,
}

struct LayerCounts {
    identifier: String,
    applied: usize,
    saved: usize,
}

impl LayerLedger {
    fn new() -> Self {
        LayerLedger {
            entries: Vec::new(),
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
    }

    fn counts_of(&mut self, identifier: &str) -> &mut LayerCounts {
        if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.identifier == identifier)
        {
            return &mut self.entries[index];
        }
        self.entries.push(LayerCounts {
            identifier: identifier.to_owned(),
            applied: 0,
            saved: 0,
        });
        self.entries.last_mut().expect("just pushed")
    }

    /// A mutation (or redo) applied one more unsaved change to the layer.
    fn record_mutation(&mut self, identifier: &str) {
        self.counts_of(identifier).applied += 1;
    }

    /// An undo reverted the newest applied change on the layer.
    fn record_undo(&mut self, identifier: &str) {
        let counts = self.counts_of(identifier);
        counts.applied = counts.applied.saturating_sub(1);
    }

    /// A successful save persisted exactly the currently applied changes.
    fn record_saved(&mut self, identifier: &str) {
        let counts = self.counts_of(identifier);
        counts.saved = counts.applied;
    }

    /// The layers with applied changes the files on disk lack, in
    /// first-edit order.
    fn dirty(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| entry.applied != entry.saved)
            .map(|entry| entry.identifier.clone())
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditTargetInfo {
    pub layer_identifier: String,
    pub is_session: bool,
    pub is_usdz_stage: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerInfo {
    pub identifier: String,
    pub original_path: Option<String>,
    pub is_session: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerSaveRequest {
    pub identifier: String,
    pub path: String,
}

/// Map-level `usd-stage-changed` emitter: called with the stage's id and
/// the edited prim paths after each successful mutation. lib.rs bridges it
/// to the Tauri event (payload `{ "stage_id", "paths" }`); tests capture
/// it in a channel. Arc so StageState can hand one clone to every spawned
/// owner thread.
pub type StageEventSink = Arc<dyn Fn(u64, &[String]) + Send + Sync>;

/// A sink that swallows every emission (tests that ignore events).
pub fn noop_sink() -> StageEventSink {
    Arc::new(|_stage_id: u64, _paths: &[String]| {})
}

/// The keyed stage map: one entry per open stage, each owning a fresh
/// owner thread (and its caches). The id counter starts at 1 — 0 stays
/// reserved as the frontend's "no stage".
pub struct StageState {
    stages: Mutex<HashMap<u64, StageHandle>>,
    next_id: AtomicU64,
    sink: StageEventSink,
}

struct StageHandle {
    sender: mpsc::Sender<StageRequest>,
    // Tessellations the owner's MeshCache filled since the last Open.
    // Shared handle so tests (and any introspection) can count real
    // tessellation work without reaching into the owner thread; used by
    // the dedup pin.
    tessellations: Arc<AtomicUsize>,
    // Tree serialize_tree calls since the last Open: a cache-miss count, so
    // tests can tell a kept stage_tree from a rebuilt one (the warm-path
    // pins). Cold clears and rebuilds leave it where it was.
    tree_serializations: Arc<AtomicUsize>,
    // Pose frame cache hits since the last Open: a repeated playhead time
    // served from the assembled frame instead of a fresh delta walk, which
    // is what the frame-cache pins assert without timing anything.
    pose_frame_hits: Arc<AtomicUsize>,
}

impl StageState {
    pub fn new(sink: StageEventSink) -> Self {
        StageState {
            stages: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            sink,
        }
    }

    /// The sender of one open stage — every stage-scoped command routes
    /// through this lookup, so an unknown or closed id is one readable
    /// error for every command shape.
    pub fn sender(&self, stage_id: u64) -> Result<mpsc::Sender<StageRequest>, String> {
        self.stages
            .lock()
            .map_err(|_| "stage map lock poisoned".to_string())?
            .get(&stage_id)
            .map(|handle| handle.sender.clone())
            .ok_or_else(|| format!("no stage {}", stage_id))
    }

    pub fn mesh_tessellations(&self, stage_id: u64) -> Result<usize, String> {
        self.stages
            .lock()
            .map_err(|_| "stage map lock poisoned".to_string())?
            .get(&stage_id)
            .map(|handle| handle.tessellations.load(Ordering::Relaxed))
            .ok_or_else(|| format!("no stage {}", stage_id))
    }

    pub fn stage_tree_serializations(&self, stage_id: u64) -> Result<usize, String> {
        self.stages
            .lock()
            .map_err(|_| "stage map lock poisoned".to_string())?
            .get(&stage_id)
            .map(|handle| handle.tree_serializations.load(Ordering::Relaxed))
            .ok_or_else(|| format!("no stage {}", stage_id))
    }

    pub fn pose_frame_hits(&self, stage_id: u64) -> Result<usize, String> {
        self.stages
            .lock()
            .map_err(|_| "stage map lock poisoned".to_string())?
            .get(&stage_id)
            .map(|handle| handle.pose_frame_hits.load(Ordering::Relaxed))
            .ok_or_else(|| format!("no stage {}", stage_id))
    }

    /// The dependency scan of one open stage, from its own owner: the scan
    /// walks the layers the owner parsed, so the caller pays no second
    /// parse of the root layer.
    pub fn get_dependencies(&self, stage_id: u64) -> Result<DependencyScan, String> {
        let sender = self.sender(stage_id)?;
        let (reply, response) = mpsc::channel();
        sender
            .send(StageRequest::GetDependencies { reply })
            .map_err(|_| "stage service unavailable".to_string())?;
        response
            .recv()
            .map_err(|_| "stage service unavailable".to_string())?
    }

    /// Open a stage as a NEW map entry: mint the id, spawn a fresh owner
    /// thread, send the Open, and wait for the reply. A failed open removes
    /// only the entry it created (and shuts the fresh owner down, cleaning
    /// up what it recorded); every other stage is untouched.
    pub fn open(
        &self,
        path: &Path,
        is_usdz: bool,
        source_usdz: Option<&Path>,
        extraction_dir: Option<&Path>,
    ) -> Result<StageInfo, String> {
        let stage_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        let tessellations = Arc::new(AtomicUsize::new(0));
        let tree_serializations = Arc::new(AtomicUsize::new(0));
        let pose_frame_hits = Arc::new(AtomicUsize::new(0));
        spawn_stage_owner_for(
            stage_id,
            self.sink.clone(),
            receiver,
            tessellations.clone(),
            tree_serializations.clone(),
            pose_frame_hits.clone(),
        );
        self.stages
            .lock()
            .map_err(|_| "stage map lock poisoned".to_string())?
            .insert(
                stage_id,
                StageHandle {
                    sender: sender.clone(),
                    tessellations,
                    tree_serializations,
                    pose_frame_hits,
                },
            );
        let (reply, response) = mpsc::channel();
        if sender
            .send(StageRequest::Open {
                path: path.to_path_buf(),
                is_usdz,
                source_usdz: source_usdz.map(Path::to_path_buf),
                extraction_dir: extraction_dir.map(Path::to_path_buf),
                reply,
            })
            .is_err()
        {
            // The fresh owner died before accepting the open: leave no
            // entry behind (nothing was opened, nothing to clean up).
            self.abandon(stage_id, sender);
            return Err("stage service unavailable".to_string());
        }
        match response.recv() {
            Ok(Ok(info)) => Ok(info),
            Ok(Err(error)) => {
                self.abandon(stage_id, sender);
                Err(error)
            }
            Err(_) => {
                self.abandon(stage_id, sender);
                Err("stage service unavailable".to_string())
            }
        }
    }

    /// Remove a failed open's entry and shut its fresh owner down so the
    /// thread (and its recorded cleanup paths) cannot outlive the error.
    fn abandon(&self, stage_id: u64, sender: mpsc::Sender<StageRequest>) {
        if let Ok(mut stages) = self.stages.lock() {
            stages.remove(&stage_id);
        }
        let (reply, response) = mpsc::channel();
        if sender.send(StageRequest::Shutdown { reply }).is_ok() {
            let _ = response.recv();
        }
    }

    /// Close one stage: remove the map entry first (commands against the
    /// id fail readably from here on), then let the owner delete its
    /// session file and extraction dir, drop the stage, and exit. Closing
    /// the last stage is fine — the frontend shows its empty state.
    pub fn close_stage(&self, stage_id: u64) -> Result<(), String> {
        let handle = {
            let mut stages = self
                .stages
                .lock()
                .map_err(|_| "stage map lock poisoned".to_string())?;
            stages
                .remove(&stage_id)
                .ok_or_else(|| format!("no stage {}", stage_id))?
        };
        let (reply, response) = mpsc::channel();
        handle
            .sender
            .send(StageRequest::Shutdown { reply })
            .map_err(|_| "stage service unavailable".to_string())?;
        response
            .recv()
            .map_err(|_| "stage service unavailable".to_string())?
    }

    /// Every open stage with its root layer and dirty-layer count. Owners
    /// answer through their channels; a dead owner is skipped, not fatal.
    pub fn list_stages(&self) -> Result<Vec<StageSummary>, String> {
        let senders: Vec<(u64, mpsc::Sender<StageRequest>)> = {
            let stages = self
                .stages
                .lock()
                .map_err(|_| "stage map lock poisoned".to_string())?;
            stages
                .iter()
                .map(|(stage_id, handle)| (*stage_id, handle.sender.clone()))
                .collect()
        };
        let mut summaries = Vec::with_capacity(senders.len());
        for (stage_id, sender) in senders {
            let (reply, response) = mpsc::channel();
            if sender.send(StageRequest::GetSummary { reply }).is_err() {
                continue;
            }
            if let Ok(Ok(summary)) = response.recv() {
                summaries.push(summary);
            } else {
                eprintln!("usdbee: stage {} did not report a summary", stage_id);
            }
        }
        Ok(summaries)
    }
}

/// Actor-side `usd-stage-changed` emitter: called with the edited prim
/// paths after each successful mutation. lib.rs bridges it to the Tauri
/// event; tests capture it in a channel.
pub type StageChangeSink = Box<dyn Fn(&[String]) + Send>;

/// Spawn the owner thread of one stage id. The per-thread actor is
/// unchanged from the single-stage era: one thread, one stage, one cache
/// set; only the entry point is keyed now.
fn spawn_stage_owner_for(
    stage_id: u64,
    event_sink: StageEventSink,
    receiver: mpsc::Receiver<StageRequest>,
    tessellations: Arc<AtomicUsize>,
    tree_serializations: Arc<AtomicUsize>,
    pose_frame_hits: Arc<AtomicUsize>,
) {
    let owner_counter = tessellations.clone();
    let owner_frame_hits = pose_frame_hits.clone();
    thread::spawn(move || {
        // Bind the map-level (id, paths) sink to this stage's id so the
        // loop's emission call sites stay one-arg.
        let sink: Option<StageChangeSink> = Some(Box::new(move |paths: &[String]| {
            event_sink(stage_id, paths)
        }));
        // The stage lives wrapped in openusd's capture recorders: the
        // UndoStage (inverse diffs, bounded UNDO_DEPTH) and the ReplayStage
        // (forward diffs) both install their sinks on the one underlying
        // stage — the sinks compose (verified against the 0.8.0 source:
        // CaptureStage installs per-wrapper sinks via add_sink on the
        // shared Rc stage, pinned by the undo/redo tests). Every read and
        // mutation goes through their `Deref<Target = Stage>`.
        let mut current_stage: Option<UndoStage> = None;
        let mut current_replay: Option<ReplayStage> = None;
        let mut mesh_cache = MeshCache::with_counter(owner_counter.clone());
        // Assembled pose frames by queried time, on the same lifecycle as the
        // mesh cache: a warm pose is then a lookup plus the reply's one copy.
        let mut pose_frames = PoseFrameCache::with_counter(owner_frame_hits.clone());
        // Sampled local matrices by (prim, time), beside the mesh cache: the
        // animated half of the walk's transform, memoized across calls and
        // cleared wherever the caches clear.
        let mut transform_memo = new_transform_memo();
        // The time-independent manifest skeleton, built by the first manifest
        // call after an open; cleared on Open (like the geometry MeshCache).
        let mut manifest_skeleton: Option<ManifestSkeleton> = None;
        // The built prim tree, riding the same epoch as the skeleton: cleared
        // wherever the skeleton is (Open and every committed mutation).
        let mut stage_tree: Option<Vec<PrimNode>> = None;
        // One entry per committed user mutation, mirroring the UndoStage's
        // bounded stack (both cap at UNDO_DEPTH; the crate evicts the oldest
        // transaction, the journal pops its front). `redo_stack` holds the
        // entries undo popped, newest-undo-first.
        let mut undo_journal: VecDeque<MutationEntry> = VecDeque::new();
        let mut redo_stack: Vec<MutationEntry> = Vec::new();
        // Edit-target layers with unsaved edits, as per-layer applied/saved
        // counts so undo/redo restore the dirty set coherently; cleared on
        // Open. openusd's `Layer::is_dirty` only reports in-flight overlay
        // edits (it drains at every commit), so "unsaved on disk" is
        // owner-side bookkeeping.
        let mut dirty_ledger = LayerLedger::new();
        // Stamped at Open from the request's usdz-origin flag OR the opened
        // path's suffix; a usdz-opened stage cannot save layers (Task 7
        // adds the Save As usdz path).
        let mut stage_is_usdz = false;
        let mut stage_source_usdz: Option<PathBuf> = None;
        // Requested-render-path -> geometry-cache-key resolutions, shared by
        // the geometry/material arms; cleared on Open. Prototype resolution
        // measured 0.4 ms/call (Task 1 profile c): memoizing turns repeats
        // and batch dups into map lookups.
        let mut resolve_memo = ResolveMemo::new();
        // Cleanup paths this owner owns: the session layer file its open
        // wrote and the dialog flow's extraction dir. Deleted on Shutdown
        // (close_stage or a failed open's cleanup).
        let mut session_path: Option<PathBuf> = None;
        let mut extraction_dir: Option<PathBuf> = None;
        while let Ok(request) = receiver.recv() {
            match request {
                StageRequest::Open {
                    path,
                    is_usdz,
                    source_usdz,
                    extraction_dir: requested_extraction_dir,
                    reply,
                } => {
                    // Recorded before the attempt: a failed open shuts this
                    // fresh owner down (StageState::open), and the cleanup
                    // then removes the extraction dir with it.
                    extraction_dir = requested_extraction_dir;
                    let response = catch_unwind(AssertUnwindSafe(|| {
                        let (stage, mut info) = open_stage(&path)?;
                        info.stage_id = stage_id;
                        // Both wrappers install their sinks on the one
                        // stage before either replaces the old slots, so a
                        // panic between the wraps cannot strand recorders
                        // on a stage the owner then discards.
                        let replay = ReplayStage::from(stage.clone());
                        let undo = UndoStage::with_capacity(stage, UNDO_DEPTH);
                        current_stage = Some(undo);
                        current_replay = Some(replay);
                        Ok(info)
                    }))
                    .unwrap_or_else(panic_reply);
                    if response.is_ok() {
                        let direct_usdz = path
                            .extension()
                            .and_then(|extension| extension.to_str())
                            .is_some_and(|extension| extension.eq_ignore_ascii_case("usdz"));
                        stage_is_usdz = is_usdz || direct_usdz;
                        stage_source_usdz =
                            source_usdz.or_else(|| direct_usdz.then_some(path.clone()));
                        mesh_cache.clear();
                        pose_frames.clear();
                        transform_memo.clear();
                        manifest_skeleton = None;
                        stage_tree = None;
                        resolve_memo.clear();
                        dirty_ledger.clear();
                        undo_journal.clear();
                        redo_stack.clear();
                        owner_counter.store(0, Ordering::Relaxed);
                        owner_frame_hits.store(0, Ordering::Relaxed);
                        tree_serializations.store(0, Ordering::Relaxed);
                        // The session layer file this open created: the
                        // owner deletes it on Shutdown (the ride-along
                        // temp-file cleanup — session edits are never
                        // saved, so close is the only cleanup they need).
                        session_path = current_stage.as_ref().and_then(|stage| {
                            stage
                                .session_layer()
                                .and_then(|layer| layer.resolved_path().map(PathBuf::from))
                        });
                    }
                    let _ = reply.send(response);
                }
                StageRequest::GetTree { reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            if stage_tree.is_none() {
                                // A failed build leaves the cache empty, so
                                // the next call retries instead of serving it.
                                stage_tree = Some(serialize_tree(stage)?);
                                // Only the rebuild counts: a cache hit is the
                                // warm keep this counter exists to pin.
                                tree_serializations.fetch_add(1, Ordering::Relaxed);
                            }
                            match stage_tree {
                                // Clone-on-reply: the cache keeps its own copy.
                                Some(ref tree) => Ok(tree.clone()),
                                None => Err("stage tree build failed".to_string()),
                            }
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetDependencies { reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            // The root layer's own identifier anchors the
                            // entry keys and keeps the walk on the layers
                            // this stage already holds.
                            dependency_scan_from_stage(
                                stage,
                                Path::new(stage.root_layer().identifier()),
                            )
                        }))
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
                            if manifest_skeleton.is_none() {
                                manifest_skeleton = Some(ManifestSkeleton::build(stage)?);
                            }
                            let skeleton = manifest_skeleton
                                .as_ref()
                                .ok_or_else(|| "manifest skeleton build failed".to_string())?;
                            let mut ctx = WalkCtx::new(&mut transform_memo);
                            render_children(
                                skeleton,
                                &skeleton.root_children,
                                time,
                                false,
                                &mut ctx,
                            )
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetAnimatedManifest { time, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            if manifest_skeleton.is_none() {
                                manifest_skeleton = Some(ManifestSkeleton::build(stage)?);
                            }
                            let skeleton = manifest_skeleton
                                .as_ref()
                                .ok_or_else(|| "manifest skeleton build failed".to_string())?;
                            let mut ctx = WalkCtx::new(&mut transform_memo);
                            delta_children(
                                skeleton,
                                &skeleton.root_children,
                                time,
                                false,
                                &mut ctx,
                                false,
                                false,
                            )
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetTimeCodes { reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            if manifest_skeleton.is_none() {
                                manifest_skeleton = Some(ManifestSkeleton::build(stage)?);
                            }
                            Ok(manifest_skeleton
                                .as_ref()
                                .map(|skeleton| skeleton.time_codes.clone())
                                .unwrap_or_default())
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetGeometry { path, time, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            geometry_bytes(stage, &mut mesh_cache, &mut resolve_memo, &path, time)
                                .map(|packed| packed.to_vec())
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetGeometryBatch { paths, time, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            let slots = paths
                                .iter()
                                .map(|path| {
                                    geometry_bytes(
                                        stage,
                                        &mut mesh_cache,
                                        &mut resolve_memo,
                                        path,
                                        time,
                                    )
                                })
                                .collect();
                            Ok(frame_batch(slots))
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetAnimatedPose { time, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            if let Some(frame) = pose_frames.get(time) {
                                return Ok(frame.to_vec());
                            }
                            if manifest_skeleton.is_none() {
                                manifest_skeleton = Some(ManifestSkeleton::build(stage)?);
                            }
                            let skeleton = manifest_skeleton
                                .as_ref()
                                .ok_or_else(|| "manifest skeleton build failed".to_string())?;
                            let nodes = {
                                let mut ctx = WalkCtx::new(&mut transform_memo);
                                delta_children(
                                    skeleton,
                                    &skeleton.root_children,
                                    time,
                                    false,
                                    &mut ctx,
                                    false,
                                    false,
                                )?
                            };
                            let paths = animated_geometry_paths(&nodes);
                            let slots: Vec<Result<Arc<[u8]>, String>> = paths
                                .iter()
                                .map(|path| {
                                    geometry_bytes(
                                        stage,
                                        &mut mesh_cache,
                                        &mut resolve_memo,
                                        path,
                                        time,
                                    )
                                })
                                .collect();
                            let frame: Arc<[u8]> = frame_pose(&nodes, &slots)?.into();
                            pose_frames.insert(time, frame.clone());
                            Ok(frame.to_vec())
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetMaterial { path, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            resolved_material_info(stage, &mut resolve_memo, &path)
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetMaterialBatch { paths, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            let slots = paths
                                .iter()
                                .map(|path| {
                                    resolved_material_info(stage, &mut resolve_memo, path).and_then(
                                        |info| {
                                            serde_json::to_vec(&info).map_err(|e| {
                                                format!("material serialize failed: {}", e)
                                            })
                                        },
                                    )
                                })
                                .collect();
                            Ok(frame_batch(slots))
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::SetValue {
                    path,
                    name,
                    value,
                    time,
                    reply,
                } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            author_attribute_value(stage, &path, &name, &value, time)
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    if response.is_ok() {
                        if let (Some(ref stage), Some(ref replay)) =
                            (&current_stage, &current_replay)
                        {
                            // Decided before the warm/cold split so both arms
                            // announce the same path: a prototype-subtree
                            // edit must reach the frontend as a full rebuild.
                            let emitted = edit_emission_path(stage, &path);
                            // The gizmo's hot path: a default-time xform op /
                            // order write cannot change the tree shape or any
                            // time-independent skeleton fact, yet the coarse
                            // clear cost ~700 ms of tree rebuild plus ~3.4 s
                            // of skeleton rebuild per commit (measured, see
                            // .agents/knowledge/gizmo-edit-commit-costs.md).
                            // Only the edited prim's cached static transform
                            // can go stale. Sampled writes and every other
                            // mutation keep the coarse clear.
                            let warm_xform = time.is_none()
                                && (name == "xformOpOrder" || name.starts_with("xformOp:"));
                            record_user_mutation(
                                replay,
                                &mut undo_journal,
                                &mut redo_stack,
                                &mut dirty_ledger,
                                stage.edit_target().layer_identifier(),
                                &path,
                                warm_xform,
                            );
                            if warm_xform {
                                warm_xform_keep(
                                    &sink,
                                    &mut mesh_cache,
                                    &mut pose_frames,
                                    &mut manifest_skeleton,
                                    &mut resolve_memo,
                                    &mut transform_memo,
                                    &emitted,
                                );
                            } else {
                                after_mutation(
                                    &sink,
                                    &mut mesh_cache,
                                    &mut pose_frames,
                                    &mut manifest_skeleton,
                                    &mut stage_tree,
                                    &mut resolve_memo,
                                    &mut transform_memo,
                                    &emitted,
                                );
                            }
                        }
                    }
                    let _ = reply.send(response);
                }
                StageRequest::SetMetadata {
                    path,
                    key,
                    value,
                    reply,
                } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            author_prim_metadata(stage, &path, &key, &value)
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    if response.is_ok() {
                        if let (Some(ref stage), Some(ref replay)) =
                            (&current_stage, &current_replay)
                        {
                            record_user_mutation(
                                replay,
                                &mut undo_journal,
                                &mut redo_stack,
                                &mut dirty_ledger,
                                stage.edit_target().layer_identifier(),
                                &path,
                                false,
                            );
                            after_mutation(
                                &sink,
                                &mut mesh_cache,
                                &mut pose_frames,
                                &mut manifest_skeleton,
                                &mut stage_tree,
                                &mut resolve_memo,
                                &mut transform_memo,
                                &path,
                            );
                        }
                    }
                    let _ = reply.send(response);
                }
                StageRequest::SetVariantSelection {
                    path,
                    variant_set,
                    selection,
                    reply,
                } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            author_variant_selection(
                                stage,
                                &path,
                                &variant_set,
                                selection.as_deref(),
                            )
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    if response.is_ok() {
                        if let (Some(ref stage), Some(ref replay)) =
                            (&current_stage, &current_replay)
                        {
                            record_user_mutation(
                                replay,
                                &mut undo_journal,
                                &mut redo_stack,
                                &mut dirty_ledger,
                                stage.edit_target().layer_identifier(),
                                &path,
                                false,
                            );
                            after_mutation(
                                &sink,
                                &mut mesh_cache,
                                &mut pose_frames,
                                &mut manifest_skeleton,
                                &mut stage_tree,
                                &mut resolve_memo,
                                &mut transform_memo,
                                &path,
                            );
                        }
                    }
                    let _ = reply.send(response);
                }
                StageRequest::SetPrimTexture {
                    path,
                    texture,
                    reply,
                } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            author_prim_texture(stage, &path, texture.as_deref())
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    if response.is_ok() {
                        if let (Some(ref stage), Some(ref replay)) =
                            (&current_stage, &current_replay)
                        {
                            record_user_mutation(
                                replay,
                                &mut undo_journal,
                                &mut redo_stack,
                                &mut dirty_ledger,
                                stage.edit_target().layer_identifier(),
                                &path,
                                false,
                            );
                            after_mutation(
                                &sink,
                                &mut mesh_cache,
                                &mut pose_frames,
                                &mut manifest_skeleton,
                                &mut stage_tree,
                                &mut resolve_memo,
                                &mut transform_memo,
                                &path,
                            );
                        }
                    }
                    let _ = reply.send(response);
                }
                StageRequest::GetEditTarget { reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            edit_target_info(stage, stage_is_usdz)
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::SetEditTarget { identifier, reply } => {
                    // Switching the target changes where FUTURE edits land;
                    // composition is untouched, so no caches clear and no
                    // usd-stage-changed fires.
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            switch_edit_target(stage, identifier.as_deref())
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::ListDirtyLayers { reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            dirty_layers_info(stage, &dirty_ledger.dirty())
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::SaveLayers { requests, reply } => {
                    // Saving writes copies through Layer::export: the layer's
                    // identifier is unchanged, composition is unchanged, so
                    // no caches clear and usd-stage-changed is NOT emitted.
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            save_requested_layers(stage, stage_is_usdz, &requests)?;
                            for request in &requests {
                                dirty_ledger.record_saved(&request.identifier);
                            }
                            Ok(())
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::SaveStageAsUsdz { path, reply } => {
                    // A usdz export writes a NEW archive from the composed
                    // stage; the open stage's composition is untouched, so no
                    // caches clear, no layer goes clean, and
                    // usd-stage-changed is NOT emitted.
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            export_stage_as_usdz(stage, stage_source_usdz.as_deref(), &path)
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::Undo { reply } => {
                    let response = match (&current_stage, &current_replay) {
                        (Some(undo_stage), Some(_)) => catch_unwind(AssertUnwindSafe(|| {
                            undo_stage
                                .undo()
                                .map_err(|e| format!("failed to undo: {}", e))
                        }))
                        .unwrap_or_else(panic_reply),
                        _ => Err("no stage open".to_string()),
                    };
                    if response == Ok(true) {
                        if let (Some(_), Some(replay)) = (&current_stage, &current_replay) {
                            // The undo's own commit reached the ReplayStage's
                            // sink too (only the UndoStage suspends recording
                            // during its replay); the revert diffs it logged
                            // re-derive from the journal's forward ones, so
                            // drain and drop.
                            let _ = replay.diff();
                            replay.clear();
                        }
                        match undo_journal.pop_back() {
                            Some(entry) => {
                                dirty_ledger.record_undo(&entry.layer);
                                let path = entry.path.clone();
                                let warm_xform = entry.warm_xform;
                                redo_stack.push(entry);
                                // Reverting a default-time xform write is the
                                // same edit in reverse: the warm keep holds
                                // (undo used to pay the coarse clear too).
                                if warm_xform {
                                    warm_xform_keep(
                                        &sink,
                                        &mut mesh_cache,
                                        &mut pose_frames,
                                        &mut manifest_skeleton,
                                        &mut resolve_memo,
                                        &mut transform_memo,
                                        &path,
                                    );
                                } else {
                                    after_mutation(
                                        &sink,
                                        &mut mesh_cache,
                                        &mut pose_frames,
                                        &mut manifest_skeleton,
                                        &mut stage_tree,
                                        &mut resolve_memo,
                                        &mut transform_memo,
                                        &path,
                                    );
                                }
                            }
                            None => {
                                // The UndoStage reverted a transaction the
                                // journal does not know (an asymmetric
                                // commit); refresh coarsely rather than
                                // leave stale caches.
                                eprintln!("usdbee: undo journal desync — emitting a root refresh");
                                after_mutation(
                                    &sink,
                                    &mut mesh_cache,
                                    &mut pose_frames,
                                    &mut manifest_skeleton,
                                    &mut stage_tree,
                                    &mut resolve_memo,
                                    &mut transform_memo,
                                    "/",
                                );
                            }
                        }
                    }
                    let _ = reply.send(response);
                }
                StageRequest::Redo { reply } => {
                    let response = match (&current_stage, &current_replay) {
                        (Some(_), Some(_)) if redo_stack.is_empty() => Ok(false),
                        (Some(stage), Some(replay)) => {
                            // Pop first; a failed or panicking apply pushes
                            // the entry back so it stays redoable. One entry
                            // never spans more than its single target layer,
                            // so a failed redo applies nothing (atomic).
                            let entry = redo_stack.pop().expect("the empty case matched above");
                            let layer = entry.layer.clone();
                            let diffs = entry.diffs.clone();
                            let result = catch_unwind(AssertUnwindSafe(|| {
                                for diff in &diffs {
                                    stage
                                        .apply_diff(diff, ApplyMode::ExactLayer(&layer))
                                        .map_err(|e| {
                                            format!("failed to redo {}: {}", entry.path, e)
                                        })?;
                                }
                                Ok(true)
                            }))
                            .unwrap_or_else(panic_reply);
                            if result == Ok(true) {
                                // The re-applied edit's commit re-entered both
                                // recorders: the UndoStage holds it as a
                                // fresh undo entry and the journal mirrors
                                // that exactly.
                                let _ = replay.diff();
                                replay.clear();
                                dirty_ledger.record_mutation(&entry.layer);
                                let path = entry.path.clone();
                                let warm_xform = entry.warm_xform;
                                push_bounded(&mut undo_journal, entry);
                                // Re-applying a default-time xform write keeps
                                // the warm caches, like the write itself.
                                if warm_xform {
                                    warm_xform_keep(
                                        &sink,
                                        &mut mesh_cache,
                                        &mut pose_frames,
                                        &mut manifest_skeleton,
                                        &mut resolve_memo,
                                        &mut transform_memo,
                                        &path,
                                    );
                                } else {
                                    after_mutation(
                                        &sink,
                                        &mut mesh_cache,
                                        &mut pose_frames,
                                        &mut manifest_skeleton,
                                        &mut stage_tree,
                                        &mut resolve_memo,
                                        &mut transform_memo,
                                        &path,
                                    );
                                }
                            } else {
                                redo_stack.push(entry);
                            }
                            result
                        }
                        _ => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::GetUndoState { reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            Ok(UndoState {
                                can_undo: stage.can_undo(),
                                can_redo: !redo_stack.is_empty(),
                            })
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::ExportLayerText { identifier, reply } => {
                    // A pure read: no caches clear, no event fires.
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            export_layer_text_impl(stage, &identifier)
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::ImportLayerText {
                    identifier,
                    text,
                    reply,
                } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            import_layer_text_impl(stage, &identifier, &text)
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    if let Ok(imported_layer) = &response {
                        if let Some(ref replay) = &current_replay {
                            // The same post-mutation bookkeeping as the other
                            // arms, with the layer the import named (an import
                            // is not necessarily the edit target) and the root
                            // path (a layer-content replacement can reshape
                            // the whole composed tree).
                            record_user_mutation(
                                replay,
                                &mut undo_journal,
                                &mut redo_stack,
                                &mut dirty_ledger,
                                imported_layer,
                                "/",
                                false,
                            );
                            after_mutation(
                                &sink,
                                &mut mesh_cache,
                                &mut pose_frames,
                                &mut manifest_skeleton,
                                &mut stage_tree,
                                &mut resolve_memo,
                                &mut transform_memo,
                                "/",
                            );
                        }
                    }
                    // The command's contract is Result<(), String>: the
                    // canonical layer id the bookkeeping needed stays here.
                    let response = response.map(|_| ());
                    let _ = reply.send(response);
                }
                StageRequest::ListStageLayers { reply } => {
                    // A pure read: no caches clear, no event fires.
                    let response = match current_stage {
                        Some(ref stage) => {
                            catch_unwind(AssertUnwindSafe(|| stage_layers_info(stage)))
                                .unwrap_or_else(panic_reply)
                        }
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::Shutdown { reply } => {
                    // The owner's own cleanup: the session layer file this
                    // open wrote and the extraction dir it recorded. The
                    // stage drops when the loop below breaks and the
                    // thread's state falls away with it.
                    if let Some(path) = session_path.take() {
                        if let Err(e) = fs::remove_file(&path) {
                            eprintln!(
                                "usdbee: could not remove the session layer {}: {}",
                                path.display(),
                                e
                            );
                        }
                    }
                    if let Some(dir) = extraction_dir.take() {
                        if let Err(e) = fs::remove_dir_all(&dir) {
                            eprintln!(
                                "usdbee: could not remove the extraction dir {}: {}",
                                dir.display(),
                                e
                            );
                        }
                    }
                    let _ = reply.send(Ok(()));
                    break;
                }
                StageRequest::GetSummary { reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            Ok(StageSummary {
                                stage_id,
                                root_identifier: stage.root_layer().identifier().to_owned(),
                                dirty_count: dirty_ledger.dirty().len() as u32,
                            })
                        }))
                        .unwrap_or_else(panic_reply),
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
            }
        }
    });
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
    // The keyed map's id of the stage this info describes; 0 only in infos
    // built before an owner stamps the real id (the free open_stage
    // entry point used by read-only tests).
    pub stage_id: u64,
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

/// One open stage as list_stages reports it: the id commands address it
/// by, its root layer identifier, and how many of its layers carry
/// unsaved edits (from the owner's dirty ledger).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageSummary {
    pub stage_id: u64,
    pub root_identifier: String,
    pub dirty_count: u32,
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

/// A fresh, empty session layer file for one stage open. The builder's
/// `session_layer` takes a path the resolver reads, so the default edit
/// target is a real (private, never saved) layer on disk; each open gets
/// its own so previous edits never leak into a reopened stage.
fn session_layer_file() -> Result<PathBuf, String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = get_usdbee_cache_dir().join("sessions");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create session dir {}: {}", dir.display(), e))?;
    let path = dir.join(format!(
        "session-{}-{}.usda",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    // shortcut: one tiny session file per open accumulates in the cache dir
    // until the OS temp sweep; session edits are never saved, so a delete-on-
    // stage-close is the only cleanup ever needed
    fs::write(&path, "#usda 1.0\n")
        .map_err(|e| format!("failed to write session layer {}: {}", path.display(), e))?;
    Ok(path)
}

pub fn open_stage(path: &Path) -> Result<(Stage, StageInfo), String> {
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("USD stage path is not valid UTF-8: {}", path.display()))?;
    let cache_dir = get_usdbee_cache_dir();
    let resolver =
        DefaultResolver::with_search_paths([cache_dir.clone(), cache_dir.join("extracted")]);
    let mut builder = Stage::builder()
        // Registers every enabled openusd-schemas family so `is_a`/
        // `from_prim` detection and schema-declared fallbacks resolve
        // (Task 3; Mesh topology declares no fallback, so the
        // missing-topology Err semantics of tessellation are unchanged).
        .schema_registry(openusd_schemas::schema_registry())
        .resolver(resolver)
        .load(InitialLoadSet::LoadAll);
    // The stage must open WITH a session layer (the default edit target);
    // when creation fails the stage still opens read-only and mutations
    // return a readable error instead of silently authoring into the root.
    if let Ok(session) = session_layer_file() {
        if let Some(session) = session.to_str() {
            builder = builder.session_layer(session);
        }
    }
    let stage = builder
        .open(path_str)
        .map_err(|e| format!("Failed to open USD stage '{}': {}", path.display(), e))?;
    stage
        .traverse(PrimPredicate::ALL, |_| {})
        .map_err(|e| format!("Failed to compose USD stage '{}': {}", path.display(), e))?;
    if let Some(target) = stage.edit_target_session() {
        if let Err(e) = stage.set_edit_target(target) {
            eprintln!(
                "usdbee: could not select the session edit target ({}); edits stay on {}",
                e,
                stage.edit_target().layer_identifier()
            );
        }
    } else {
        eprintln!(
            "usdbee: {} opened without a session layer; edits are disabled",
            path.display()
        );
    }

    let info = StageInfo {
        stage_id: 0,
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

/// The guards every mutation shares: the prim must exist, must not be an
/// instance (or live inside one), must be active, and the stage must have
/// its session edit layer. Failures are readable and carry the prim path.
/// `allow_inactive` opens the single sanctioned exception: metadata
/// `active = true` may target an inactive prim (it is the only way back).
fn editable_prim(
    stage: &Stage,
    path: &str,
    allow_inactive: bool,
) -> Result<openusd::usd::Prim, String> {
    let prim_path =
        sdf::try_into_path(path).map_err(|e| format!("invalid prim path '{}': {}", path, e))?;
    let prim = stage
        .prim(prim_path)
        .map_err(|e| format!("invalid prim path '{}': {}", path, e))?;
    if !prim.is_valid().map_err(stage_err)? {
        return Err(format!("prim not found: {}", path));
    }
    if prim.is_instance().map_err(stage_err)? {
        let prototype = prim
            .prototype()
            .map_err(stage_err)?
            .map(|prototype| prototype.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        return Err(format!(
            "edits on instances affect all instances — edit the prototype at {}",
            prototype
        ));
    }
    if prim.is_instance_proxy().map_err(stage_err)? {
        let prototype = prim
            .prim_in_prototype()
            .map_err(stage_err)?
            .map(|prototype| prototype.path().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        return Err(format!(
            "edits inside an instance affect all instances — edit the prototype at {}",
            prototype
        ));
    }
    if !prim.is_active().map_err(stage_err)? && !allow_inactive {
        return Err(format!(
            "prim {} is inactive; reactivate it before editing",
            path
        ));
    }
    if !stage.has_session_layer() {
        return Err(format!("no session layer available for edits on {}", path));
    }
    Ok(prim)
}

/// The ValueTypeName spelling for a payload type: identical to the payload
/// family except the value-type registry calls asset paths "asset".
fn payload_type_name(payload: &ValuePayload) -> Result<ValueTypeName, String> {
    // The serializer's generic spellings map back to the declared USD
    // names create_attribute expects (the gizmo sends the declared
    // spellings directly; these arms keep the round trip consistent). The
    // color-array tags map onto the registered array names: the crate has
    // no color-specific Value kind, and "vec3f[]" is not a registered
    // spelling (the family's usda name is float3[]).
    let spelling = match payload.r#type.as_str() {
        "assetpath" => "asset",
        "vec3f" => "float3",
        "vec3d" => "double3",
        "token_array" => "token[]",
        "color3f_array" => "color3f[]",
        "float3_array" | "vec3f_array" => "float3[]",
        other => other,
    };
    ValueTypeName::find(spelling)
        .ok_or_else(|| format!("cannot create an attribute of type {}", payload.r#type))
}

/// Author an attribute value on the current edit target (the session layer
/// — see `open_stage`). `time` is a USD time code (frames); `None` authors
/// the default. An attribute nothing declares is created via
/// `Stage::create_attribute` with the payload's type.
fn author_attribute_value(
    stage: &Stage,
    path: &str,
    name: &str,
    payload: &ValuePayload,
    time: Option<f64>,
) -> Result<(), String> {
    let prim = editable_prim(stage, path, false)?;
    let value = value_payload_to_sdf(payload)?;
    let time = time.map(TimeCode::new);
    let authored = prim
        .attributes()
        .map_err(stage_err)?
        .into_iter()
        .find(|attribute| attribute.name() == name);
    match authored {
        // set_at stamps the edit-target spec from the composed declaration
        // when the attribute is declared but unauthored.
        Some(attribute) => {
            attribute
                .set_at(value, time)
                .map_err(|e| format!("failed to set {} on {}: {}", name, path, e))?;
        }
        None => {
            let attribute_path = prim
                .path()
                .append_property(name)
                .map_err(|e| format!("invalid attribute path {}.{}: {}", path, name, e))?;
            // One builder edit: the spec AND its value commit as a single
            // transaction, so one undo reverts the whole creation — a
            // separate create_attribute call would make the creation two
            // undo steps.
            stage
                .attribute_builder(attribute_path, payload_type_name(payload)?)
                .set_at(value, time)
                .build()
                .map_err(|e| format!("failed to create {} on {}: {}", name, path, e))?;
        }
    }
    Ok(())
}

/// Author a prim metadata field on the current edit target. Only the keys
/// the inspector can edit land (active, kind, customData); anything else is
/// a readable refusal. `Prim::set_metadata` takes `&'static str` keys, so
/// the dispatch is a fixed match, not a passthrough of the request key.
fn author_prim_metadata(
    stage: &Stage,
    path: &str,
    key: &str,
    payload: &ValuePayload,
) -> Result<(), String> {
    // The reactivation exception: `active` with value true is the one
    // mutation an inactive prim accepts (it is the only way back).
    let reactivating = key == "active" && payload.data == serde_json::Value::Bool(true);
    let prim = editable_prim(stage, path, reactivating)?;
    let value = value_payload_to_sdf(payload)?;
    match key {
        "active" => {
            let active = match value {
                sdf::Value::Bool(active) => active,
                _ => return Err(format!("active metadata needs a bool value on {}", path)),
            };
            prim.set_active(active)
                .map_err(|e| format!("failed to set active on {}: {}", path, e))?;
        }
        "kind" => {
            let kind = match value {
                sdf::Value::Token(token) => token.as_str().to_owned(),
                sdf::Value::String(text) => text,
                _ => return Err(format!("kind metadata needs a token value on {}", path)),
            };
            prim.set_kind(kind)
                .map_err(|e| format!("failed to set kind on {}: {}", path, e))?;
        }
        "customData" => {
            prim.set_metadata("customData", value)
                .map_err(|e| format!("failed to set customData on {}: {}", path, e))?;
        }
        other => {
            return Err(format!("metadata key not editable yet: {}", other));
        }
    }
    Ok(())
}

/// The `usd-stage-changed` path a successful edit announces. A prim inside
/// a native-instance prototype subtree renders under every rebased instance
/// path, so the frontend's targeted in-place refresh at the prototype path
/// would find nothing to update and the instances would stay visually
/// stale — the conservative "/" (full scene rebuild) is the only correct
/// announcement. openusd currently refuses authoring into the prototype
/// namespace outright (C++ `_ValidateEditPrim`), so this guard is the
/// emission's contract if that refusal ever lifts.
fn edit_emission_path(stage: &Stage, path: &str) -> String {
    // A detection failure must never risk a missed refresh: any error
    // reading prototype membership announces the conservative "/".
    let in_prototype = sdf::try_into_path(path)
        .map(|prim_path| {
            stage
                .prim(prim_path)
                .ok()
                .and_then(|prim| prim.is_in_prototype().ok())
                .unwrap_or(true)
        })
        .unwrap_or(true);
    if in_prototype {
        "/".to_string()
    } else {
        path.to_string()
    }
}

/// Post-success bookkeeping every mutation arm shares: the coarse cache
/// clears (tessellations, manifest skeleton, prim tree, resolve memo) and the
/// `usd-stage-changed` emission for the edited path. The dirty mark and the
/// undo journal live in `record_user_mutation` (mutation arms) or the
/// undo/redo arms' own ledger updates.
// The eight arguments are the owner-thread caches this clear must reach; a
// bundle struct would only rename them.
#[allow(clippy::too_many_arguments)]
fn after_mutation(
    sink: &Option<StageChangeSink>,
    mesh_cache: &mut MeshCache,
    pose_frames: &mut PoseFrameCache,
    manifest_skeleton: &mut Option<ManifestSkeleton>,
    stage_tree: &mut Option<Vec<PrimNode>>,
    resolve_memo: &mut ResolveMemo,
    transforms: &mut TransformMemo,
    path: &str,
) {
    // shortcut: coarse clear — any edit invalidates every cached
    // tessellation; per-path eviction when edits grow edit-target awareness
    mesh_cache.clear();
    // Assembled frames embed that geometry and the edit's transforms: every
    // one of them may be stale, and serving a pre-edit pose is the one thing
    // this cache must never do.
    pose_frames.clear();
    // shortcut: coarse clear — any edit can change composed
    // types/purpose/bindings, so the whole manifest skeleton rebuilds;
    // fine until edits become frequent
    *manifest_skeleton = None;
    // The tree may change shape too (variant switches, authored children).
    *stage_tree = None;
    resolve_memo.clear();
    transforms.clear();
    emit_stage_changed(sink, path);
}

/// The `usd-stage-changed` emission `after_mutation` ends with, split out so
/// the warm path (a kept tree and skeleton) still announces the edit.
fn emit_stage_changed(sink: &Option<StageChangeSink>, path: &str) {
    if let Some(sink) = sink {
        let edited = path.to_string();
        sink(std::slice::from_ref(&edited));
    }
}

/// The caches a default-time xform edit (and its undo/redo) can keep: the
/// prim tree holds no transform-derived field and no other prim's skeleton
/// facts depend on this one's matrix, so only the edited prim's cached static
/// transform goes, together with the transform-dependent tessellations and the
/// path resolutions.
fn warm_xform_keep(
    sink: &Option<StageChangeSink>,
    mesh_cache: &mut MeshCache,
    pose_frames: &mut PoseFrameCache,
    manifest_skeleton: &mut Option<ManifestSkeleton>,
    resolve_memo: &mut ResolveMemo,
    transforms: &mut TransformMemo,
    path: &str,
) {
    // shortcut: coarse clear — tessellation may bake transform-dependent
    // skinning
    mesh_cache.clear();
    // The frames embed those tessellations and the edited prim's matrix, so
    // the same coarse clear applies.
    pose_frames.clear();
    invalidate_skeleton_transform(manifest_skeleton, path);
    resolve_memo.clear();
    // The memo holds the pre-edit matrix for exactly the time codes the write
    // changed, and it cannot tell an animated comp from a static one, so the
    // whole map goes: serving a pre-edit pose after a gizmo commit, an undo
    // or a redo is the one thing this cache must never do.
    transforms.clear();
    emit_stage_changed(sink, path);
}

/// Undo the one cached fact a default-time xform write can falsify: the edited
/// prim's static local matrix. `None` sends the walks back to the per-call
/// `local_transform`, which reads the live stage. A path the kept facts miss
/// drops the whole skeleton — cold, never wrong.
fn invalidate_skeleton_transform(skeleton: &mut Option<ManifestSkeleton>, path: &str) {
    // take/put so the missing-path arm can clear the holder (a match on
    // `skeleton` would hold it borrowed).
    let Some(mut cached) = skeleton.take() else {
        return;
    };
    if let Some(facts) = cached.facts.get_mut(path) {
        facts.static_transform = None;
        *skeleton = Some(cached);
    }
}

/// Post-commit bookkeeping for one successful user mutation: the forward
/// diffs the ReplayStage recorded become one bounded journal entry (the
/// redo source once undone), the layer the mutation landed on gains one
/// unsaved change in the dirty ledger, and the redo stack dies (a new
/// mutation invalidates it). The layer is explicit because it is not always
/// the edit target — a text import names its own layer. An edit that
/// produced no diff ops authored nothing, so it left no UndoStage entry
/// either — nothing joins the journal (the ledger still counts it, matching
/// the pre-undo behavior of marking the edit target dirty on every
/// successful arm). `warm_xform` rides along so the undo/redo arms can keep
/// the caches the mutation itself kept.
fn record_user_mutation(
    replay: &ReplayStage,
    journal: &mut VecDeque<MutationEntry>,
    redo: &mut Vec<MutationEntry>,
    ledger: &mut LayerLedger,
    layer: &str,
    path: &str,
    warm_xform: bool,
) {
    let diffs = replay.diff();
    replay.clear();
    ledger.record_mutation(layer);
    if diffs.is_empty() {
        return;
    }
    push_bounded(
        journal,
        MutationEntry {
            layer: layer.to_owned(),
            diffs,
            path: path.to_owned(),
            warm_xform,
        },
    );
    redo.clear();
}

/// Append one journal entry, evicting the oldest when the bound the
/// UndoStage enforces on its own stack is hit (the evicted edit becomes
/// permanent, exactly as the crate's bounded undo stack treats it).
fn push_bounded(journal: &mut VecDeque<MutationEntry>, entry: MutationEntry) {
    journal.push_back(entry);
    while journal.len() > UNDO_DEPTH {
        journal.pop_front();
    }
}

/// Author (or clear, with `None`) one variant-set selection on the current
/// edit target. openusd 0.8 has no `VariantSets::set_selection` (a crate
/// TODO), so this writes the `variantSelection` field the way C++
/// `UsdPrimData::SetVariantSelection` does: read the target layer's own
/// opinion, set or remove the set's entry, erase the field when the dict
/// empties.
///
/// A target on a layer the prim composes FROM (a referenced asset) needs
/// the arc's namespace mapping: the identity mapping a plain layer target
/// carries would author at the composed path, which composes nowhere in
/// the source layer. The matching arc target (`edit_target_for_arc`) is
/// located by layer and installed for the write via `edit_context`, which
/// restores the user's target on drop.
fn author_variant_selection(
    stage: &Stage,
    path: &str,
    variant_set: &str,
    selection: Option<&str>,
) -> Result<(), String> {
    let prim = editable_prim(stage, path, false)?;
    let target_id = stage.edit_target().layer_identifier().to_string();
    for arc in [
        EditTargetArc::Reference,
        EditTargetArc::Payload,
        EditTargetArc::Inherit,
        EditTargetArc::Specialize,
    ] {
        let Ok(arc_target) = prim.edit_target_for_arc(arc) else {
            continue;
        };
        if !same_layer(stage, arc_target.layer_identifier(), &target_id) {
            continue;
        }
        // The current target IS this arc's source layer: write through the
        // arc mapping so the selection lands at the layer-side spec path.
        let context = stage
            .edit_context(arc_target)
            .map_err(|e| variant_selection_err(path, variant_set, &e))?;
        apply_variant_selection(&prim, path, variant_set, selection)?;
        drop(context);
        return Ok(());
    }
    // No arc sources the prim from the target layer: a local stack target
    // (session/root/sublayer), whose identity mapping is already correct.
    apply_variant_selection(&prim, path, variant_set, selection)
}

/// The read-modify-write of the `variantSelection` field against whatever
/// edit target is current.
fn apply_variant_selection(
    prim: &openusd::usd::Prim,
    path: &str,
    variant_set: &str,
    selection: Option<&str>,
) -> Result<(), String> {
    prim.clone()
        .update_metadata("variantSelection", |local| {
            let mut selections = match local {
                Some(sdf::Value::VariantSelectionMap(map)) => map,
                // Hand-authored layers may spell the field as a plain
                // dictionary; keep those sibling selections.
                Some(sdf::Value::Dictionary(dict)) => dict
                    .into_iter()
                    .filter_map(|(set, value)| match value {
                        sdf::Value::Token(token) => Some((set, token.as_str().to_owned())),
                        sdf::Value::String(value) => Some((set, value)),
                        _ => None,
                    })
                    .collect(),
                _ => HashMap::new(),
            };
            match selection {
                Some(selection) => {
                    selections.insert(variant_set.to_owned(), selection.to_owned());
                    Some(sdf::Value::VariantSelectionMap(selections))
                }
                None => {
                    selections.remove(variant_set);
                    // An emptied dict clears the field entirely, the way a
                    // selection delete reads back as "nothing authored here".
                    if selections.is_empty() {
                        None
                    } else {
                        Some(sdf::Value::VariantSelectionMap(selections))
                    }
                }
            }
        })
        .map(|_| ())
        .map_err(|e| variant_selection_err(path, variant_set, &e))
}

fn variant_selection_err(path: &str, variant_set: &str, error: impl std::fmt::Display) -> String {
    format!(
        "failed to set variant selection {} on {}: {}",
        variant_set, path, error
    )
}

/// Author (or clear, with `None`) the texture material for the prim at
/// `path`. `Some(texture)` builds, under a `/Looks` scope, the per-prim
/// network — a Material at a stable full-prim-path-derived `/Looks` path
/// holding a UsdPreviewSurface shader and a UsdUVTexture shader, `inputs:file` ← the texture (authored
/// verbatim; resolution is read-time), `outputs:rgb` →
/// `inputs:diffuseColor`, `outputs:surface` → the Material's terminal — and
/// binds it via MaterialBindingAPI. `None` clears the prim's
/// `material:binding` targets.
fn author_prim_texture(stage: &Stage, path: &str, texture: Option<&str>) -> Result<(), String> {
    let prim = editable_prim(stage, path, false)?;
    match texture {
        Some(texture) => bind_prim_texture(stage, &prim, path, texture),
        None => clear_prim_texture(&prim, path),
    }
}

/// One undo step for the whole network: the crate seals one undo entry per
/// committed layer transaction and `Stage::edit` batches property specs
/// only (it cannot create prim specs), so the network is authored on a
/// throwaway stage with the crate's shade API, its forward diffs merge into
/// one Diff, and a single `apply_diff` replays it onto the current edit
/// target — the same commit seam the redo arm uses.
fn texture_material_path(path: &str) -> String {
    let mut name = path
        .trim_matches('/')
        .split('/')
        .map(|segment| {
            let mut encoded = String::new();
            for byte in segment.bytes() {
                if byte.is_ascii_alphanumeric() {
                    encoded.push(char::from(byte));
                } else {
                    // Underscores are escaped too, so joining segments with
                    // '_' cannot make two distinct prim paths collide.
                    encoded.push_str(&format!("_{:02X}", byte));
                }
            }
            encoded
        })
        .collect::<Vec<_>>()
        .join("_");
    if name.starts_with(|c: char| c.is_ascii_digit()) {
        name.insert(0, '_');
    }
    format!("/Looks/{}_Mat", name)
}

fn bind_prim_texture(
    stage: &Stage,
    prim: &openusd::usd::Prim,
    path: &str,
    texture: &str,
) -> Result<(), String> {
    let scratch = ReplayStage::from(
        Stage::builder()
            .schema_registry(openusd_schemas::schema_registry())
            .in_memory("texture-material-scratch.usda")
            .map_err(|e| texture_err(path, e))?,
    );
    let material_path = texture_material_path(path);
    let author = || -> openusd::Result<()> {
        scratch.define_typed_prim("/Looks", "Scope")?;
        let material = Material::define(&scratch, material_path.clone())?;
        let surface =
            PreviewSurface::define(&scratch, format!("{}/PreviewSurface", material_path))?;
        let albedo = UVTexture::define(&scratch, format!("{}/Albedo", material_path))?;
        albedo
            .shader()
            .create_input("file", "asset")?
            .set(sdf::Value::AssetPath(sdf::AssetPath::new(texture)))?;
        let rgb = albedo.shader().create_output("rgb", "float3")?;
        surface
            .shader()
            .create_input("diffuseColor", "color3f")?
            .connect_to(&rgb)?;
        let surface_output = surface.shader().create_output("surface", "token")?;
        material
            .create_surface_output()?
            .connect_to(&surface_output)?;
        // The bound prim must compose on the scratch stage for the binding
        // authoring; its spec op is dropped from the diff below so the
        // replay never touches the target prim's own prim spec.
        let proxy = scratch.override_prim(prim.path().clone())?;
        MaterialBindingAPI::from_prim_unchecked(proxy).bind(material_path)?;
        Ok(())
    };
    author().map_err(|e| texture_err(path, e))?;
    let mut edits = Vec::new();
    for diff in scratch.diff() {
        edits.extend(diff.edits);
    }
    edits.retain(|edit| edit.path() != prim.path());
    if edits.is_empty() {
        return Err(texture_err(path, "the material network authored nothing"));
    }
    stage
        .apply_diff(
            &Diff {
                edits,
                mapping: None,
            },
            ApplyMode::CurrentEditTarget,
        )
        .map_err(|e| texture_err(path, e))
}

/// shortcut: no verified prim-removal API — the material prims under
/// /Looks stay once created (only the binding is cleared); remove the
/// path-derived material when one lands. Rel targets list-compose, so a
/// binding authored on a layer weaker than the current edit target can
/// survive the clear; v1 clears what set_prim_texture itself authored.
fn clear_prim_texture(prim: &openusd::usd::Prim, path: &str) -> Result<(), String> {
    let bound = MaterialBindingAPI::from_prim_unchecked(prim.clone())
        .direct_binding("")
        .map_err(|e| texture_err(path, e))?;
    if bound.is_none() {
        // Nothing is bound through this prim's own relationship; authoring
        // an empty target list would only create spec noise.
        return Ok(());
    }
    prim.author_relationship_targets("material:binding", None::<sdf::Path>)
        .map(|_| ())
        .map_err(|e| texture_err(path, e))
}

fn texture_err(path: &str, error: impl std::fmt::Display) -> String {
    format!(
        "failed to author the texture material on {}: {}",
        path, error
    )
}

/// Whether two layer identifiers name one layer of this stage — the
/// spellings can differ (anchored, search-path, or symlinked forms of one
/// file), so both resolve through the stage's layer registry first.
fn same_layer(stage: &Stage, a: &str, b: &str) -> bool {
    match (stage.layer(a), stage.layer(b)) {
        (Some(a), Some(b)) => a.identifier() == b.identifier(),
        _ => false,
    }
}

/// The stage's session layer identifier (USDBEE stages carry exactly one).
fn session_identifier(stage: &Stage) -> Option<String> {
    stage
        .session_layer()
        .map(|layer| layer.identifier().to_string())
}

fn edit_target_info(stage: &Stage, is_usdz_stage: bool) -> Result<EditTargetInfo, String> {
    let layer_identifier = stage.edit_target().layer_identifier().to_string();
    Ok(EditTargetInfo {
        is_session: session_identifier(stage).as_deref() == Some(layer_identifier.as_str()),
        layer_identifier,
        is_usdz_stage,
    })
}

/// Switch the edit target: `None` selects the session layer (Err when the
/// stage has none), `Some(identifier)` any layer of this stage — the same
/// validation `Stage::set_edit_target` applies (wrong-stage or unknown
/// layers are refused here, not at some later authoring call).
fn switch_edit_target(stage: &Stage, identifier: Option<&str>) -> Result<(), String> {
    let target = match identifier {
        Some(id) => EditTarget::for_layer(id.to_string()),
        None => stage
            .edit_target_session()
            .ok_or_else(|| "no session layer available as an edit target".to_string())?,
    };
    stage.set_edit_target(target).map_err(|e| {
        format!(
            "cannot switch the edit target to {}: {}",
            identifier.unwrap_or("the session layer"),
            e
        )
    })
}

/// Dirty layers in stack order (session, root, sublayers), then any dirty
/// target outside the local stack (a referenced layer the target switched
/// into). `dirty` is the owner-side truth of what mutations touched.
fn dirty_layers_info(stage: &Stage, dirty: &[String]) -> Result<Vec<LayerInfo>, String> {
    let session = session_identifier(stage);
    let stack = stage.layer_stack();
    let mut ordered: Vec<&String> = stack.iter().filter(|id| dirty.contains(id)).collect();
    for id in dirty {
        if !stack.contains(id) {
            ordered.push(id);
        }
    }
    Ok(ordered
        .into_iter()
        .filter_map(|id| {
            let layer = stage.layer(id);
            if layer.is_none() {
                eprintln!("usdbee: dirty layer {} is no longer in the stage", id);
            }
            layer.map(|layer| LayerInfo {
                identifier: id.clone(),
                original_path: layer.resolved_path().map(str::to_string),
                is_session: Some(id.as_str()) == session.as_deref(),
            })
        })
        .collect())
}

/// The file extensions `save_layers` writes (mirrors `Layer::export`, which
/// picks the writer by extension; usdz is deliberately absent — see the
/// is_usdz_stage refusal below).
const SAVEABLE_EXTENSIONS: &[&str] = &["usda", "usdc", "usd"];

/// Every loaded composed layer (session, root stack, referenced/payload
/// layers), dirty or not — the text and edit-target selectors.
fn stage_layers_info(stage: &Stage) -> Result<Vec<LayerInfo>, String> {
    let session = session_identifier(stage);
    Ok(stage
        .layer_identifiers()
        .into_iter()
        .map(|identifier| LayerInfo {
            is_session: Some(identifier.as_str()) == session.as_deref(),
            original_path: stage
                .layer(&identifier)
                .and_then(|layer| layer.resolved_path().map(str::to_string)),
            identifier,
        })
        .collect())
}

/// The usda text of one stage layer. `export_to_string` always writes usda
/// text regardless of the layer's file format, and never touches the layer's
/// file.
fn export_layer_text_impl(stage: &Stage, identifier: &str) -> Result<String, String> {
    let layer = stage
        .layer(identifier)
        .ok_or_else(|| format!("layer not found in the stage: {}", identifier))?;
    layer
        .export_to_string()
        .map_err(|e| format!("failed to export {}: {}", identifier, e))
}

/// Replace one stage layer's in-memory content with parsed usda text and
/// return the layer's canonical identifier (the request spelling may be a
/// real-path alias, but the dirty/undo bookkeeping needs the canonical id).
/// The text parses FIRST into a throwaway anonymous layer — a malformed text
/// fails before anything in the stage moves — then the parsed content swaps
/// into the target layer as one atomic `batch_edit` transaction, which also
/// recomposes the stage and feeds the undo/redo recorders. No file is ever
/// written: the layer's identifier and its file stay untouched; the owner's
/// dirty bookkeeping is what marks the layer unsaved.
fn import_layer_text_impl(stage: &Stage, identifier: &str, text: &str) -> Result<String, String> {
    let canonical = stage
        .layer(identifier)
        .map(|layer| layer.identifier().to_string())
        .ok_or_else(|| format!("layer not found in the stage: {}", identifier))?;
    let parsed = sdf::Layer::from_bytes("usdbee-import", text.as_bytes().to_vec())
        .map_err(|e| format!("failed to import into {}: {}", canonical, e))?;
    stage
        .batch_edit(&[canonical.as_str()], |edits| {
            replace_layer_content(edits[0].data_mut(), parsed.data())
                .map_err(StageAuthoringError::Layer)
        })
        .map_err(|e| format!("failed to import into {}: {}", canonical, e))?;
    Ok(canonical)
}

/// Make `dst` an exact copy of `src` at the raw spec level: erase every
/// spec the destination holds (the pseudo-root keeps its spec, its fields
/// go), then recreate every spec and field the parsed source reports. The
/// end state mirrors the parsed layer — namespace lists and layer metadata
/// included — so no per-spec merge logic is needed.
fn replace_layer_content(
    dst: &mut dyn sdf::AbstractData,
    src: &dyn sdf::AbstractData,
) -> Result<(), sdf::AuthoringError> {
    let root = sdf::Path::abs_root();
    for path in dst.spec_paths() {
        if path == root {
            for field in dst.list_fields(&path).unwrap_or_default() {
                dst.erase_field(&path, &field);
            }
        } else {
            dst.erase_spec(&path);
        }
    }
    for path in src.spec_paths() {
        let spec_type = src
            .spec_type(&path)
            .ok_or_else(|| sdf::DataError::MissingSpec { path: path.clone() })?;
        dst.create_spec(path.clone(), spec_type);
        for field in src.list_fields(&path).unwrap_or_default() {
            let value = src.get_field(&path, &field)?;
            dst.set_field(&path, &field, value.into_owned());
        }
    }
    Ok(())
}

/// Normalize one file's identity for collision checks. Existing paths
/// canonicalize through symlinks; a new destination resolves its existing
/// parent and normalizes any `..` components before the filename is added.
fn file_identity(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("failed to resolve the current directory: {}", e))?
            .join(path)
    };
    match absolute.canonicalize() {
        Ok(identity) => Ok(identity),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = absolute
                .parent()
                .ok_or_else(|| format!("destination has no parent: {}", absolute.display()))?;
            let name = absolute
                .file_name()
                .ok_or_else(|| format!("destination has no filename: {}", absolute.display()))?;
            parent
                .canonicalize()
                .map(|parent| parent.join(name))
                .map_err(|e| {
                    format!(
                        "failed to resolve destination parent {}: {}",
                        parent.display(),
                        e
                    )
                })
        }
        Err(error) => Err(format!(
            "failed to resolve destination {}: {}",
            absolute.display(),
            error
        )),
    }
}

/// Write the requested layers to disk via `Layer::export` — a copy: the
/// layer's identifier is unchanged, so composition and caches are
/// untouched. Rules: usdz-opened stages refuse entirely; extensions are
/// whitelisted; session layers only ever save to a NEW `.usda` path, never
/// over any file the stage composes from. Every request is validated
/// before any file is written (all-or-nothing). The caller (the owner arm)
/// marks the saved layers clean.
fn save_requested_layers(
    stage: &Stage,
    is_usdz_stage: bool,
    requests: &[LayerSaveRequest],
) -> Result<(), String> {
    if is_usdz_stage {
        return Err(
            "cannot save layers of a stage opened from a .usdz package; use Save As usdz instead"
                .to_string(),
        );
    }
    if requests.is_empty() {
        return Err("no layers to save".to_string());
    }
    let session = session_identifier(stage);
    let mut composed_files = Vec::new();
    for identifier in stage.layer_identifiers() {
        if let Some(path) = stage
            .layer(&identifier)
            .and_then(|layer| layer.resolved_path().map(str::to_string))
        {
            composed_files.push((identifier, file_identity(Path::new(&path))?));
        }
    }
    // Validate every request before writing any file: a batch with one bad
    // request must leave every file and the dirty state untouched (the
    // caller clears dirty ids only on a fully successful save).
    let mut validated = Vec::with_capacity(requests.len());
    let mut destinations = HashSet::with_capacity(requests.len());
    for request in requests {
        let layer = stage
            .layer(&request.identifier)
            .ok_or_else(|| format!("layer not found in the stage: {}", request.identifier))?;
        let extension = Path::new(&request.path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_lowercase)
            .unwrap_or_default();
        if !SAVEABLE_EXTENSIONS.contains(&extension.as_str()) {
            return Err(format!(
                "cannot save {} to '{}': only .usda, .usdc and .usd files are writable",
                request.identifier, request.path
            ));
        }
        let is_session = Some(request.identifier.as_str()) == session.as_deref();
        if is_session && extension != "usda" {
            return Err(format!(
                "the session layer {} only saves as a new .usda file",
                request.identifier
            ));
        }
        let destination = file_identity(Path::new(&request.path))?;
        if !destinations.insert(destination.clone()) {
            return Err(format!(
                "multiple save requests share the destination '{}'; choose a distinct path for each layer",
                request.path
            ));
        }
        if let Some((colliding, _)) = composed_files.iter().find(|(identifier, identity)| {
            *identity == destination
                && (is_session || !same_layer(stage, &request.identifier, identifier))
        }) {
            return Err(if is_session {
                format!(
                    "refusing to save the session layer over {}; session layers save to a new .usda path",
                    colliding
                )
            } else {
                format!(
                    "refusing to save {} over the composed layer {}; choose a different destination",
                    request.identifier, colliding
                )
            });
        }
        validated.push((layer, request));
    }
    for (layer, request) in validated {
        layer.export(&request.path).map_err(|e| {
            format!(
                "failed to save {} to '{}': {}",
                request.identifier, request.path, e
            )
        })?;
    }
    Ok(())
}

fn write_usdz_package(stage: &Stage, asset_path: &str, destination: &str) -> Result<(), String> {
    let skipped = openusd::usd_utils::create_new_usdz_package(
        stage,
        asset_path,
        destination,
        Some("scene.usda"),
    )
    .map_err(|e| format!("failed to save the stage as '{}': {}", destination, e))?;
    if !skipped.is_empty() {
        eprintln!(
            "usdbee: usdz export left unresolved layers out: {:?}",
            skipped
        );
    }
    Ok(())
}

/// Save As usdz through the crate's dependency-aware packager. The first
/// package preserves the original stage's unsaved layers, clips and assets.
/// A second package composes an exported in-memory session snapshot over it.
fn export_stage_as_usdz(
    stage: &Stage,
    source_usdz: Option<&Path>,
    path: &str,
) -> Result<(), String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if extension != "usdz" {
        return Err(format!(
            "cannot save the stage as '{}': only .usdz destinations are writable",
            path
        ));
    }
    if let Some(source) = source_usdz {
        if file_identity(source)? == file_identity(Path::new(path))? {
            return Err(format!(
                "refusing to overwrite the original archive '{}'; choose a new .usdz path",
                source.display()
            ));
        }
    }

    let original_root = stage.root_layer().identifier().to_string();
    if !stage.has_session_layer() {
        return write_usdz_package(stage, &original_root, path);
    }
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = get_usdbee_cache_dir().join("usdz-export");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create export dir {}: {}", dir.display(), e))?;
    let stem = format!(
        "package-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let intermediate_path = dir.join(format!("{}-base.usdz", stem));
    let session_path = dir.join(format!("{}-session.usda", stem));
    let root_path = dir.join(format!("{}-root.usda", stem));
    let intermediate = intermediate_path.to_string_lossy().to_string();
    let session_snapshot = session_path.to_string_lossy().to_string();
    let package_root_path = root_path.to_string_lossy().to_string();

    let result = (|| {
        write_usdz_package(stage, &original_root, &intermediate)?;
        let session = stage
            .session_layer()
            .ok_or_else(|| "session layer disappeared during usdz export".to_string())?;
        session
            .export(&session_snapshot)
            .map_err(|e| format!("failed to export the session layer: {}", e))?;
        drop(session);

        let mut package_root = sdf::Layer::new_anonymous("usdbee-package-root");
        package_root
            .edit(|layer| {
                layer.data_mut().set_field(
                    &sdf::Path::abs_root(),
                    "subLayers",
                    sdf::Value::StringVec(vec![
                        session_snapshot.clone(),
                        format!("{}[scene.usda]", intermediate),
                    ]),
                );
                Ok(())
            })
            .map_err(|e| format!("failed to prepare the stage for '{}': {}", path, e))?;
        package_root
            .export(&package_root_path)
            .map_err(|e| format!("failed to prepare the stage for '{}': {}", path, e))?;

        let cache_dir = get_usdbee_cache_dir();
        let resolver =
            DefaultResolver::with_search_paths([cache_dir.clone(), cache_dir.join("extracted")]);
        let package_stage = Stage::builder()
            .schema_registry(openusd_schemas::schema_registry())
            .resolver(resolver)
            .load(InitialLoadSet::LoadAll)
            .open(&package_root_path)
            .map_err(|e| format!("failed to compose the stage for '{}': {}", path, e))?;
        package_stage
            .traverse(PrimPredicate::ALL, |_| {})
            .map_err(|e| format!("failed to compose the stage for '{}': {}", path, e))?;
        write_usdz_package(&package_stage, &package_root_path, path)
    })();
    let _ = fs::remove_file(&intermediate_path);
    let _ = fs::remove_file(&session_path);
    let _ = fs::remove_file(&root_path);
    result
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

/// Per-prim manifest facts that never depend on the queried time. Verified
/// time-independent in the Task 1 profile: type names, computed purpose
/// (no time parameter), material bindings (relationships), the geometry flag
/// and the authored time-samples audit (`samples_scene_motion`) re-derive
/// identically for every call at every time. Transforms and visibility are
/// cached here too, but only their static half (`static_transform`,
/// `static_visible`): when nothing on the render path samples them, the value
/// is evaluated once and reused for every queried time. Animated or
/// unevaluable ones stay `None` and the walks sample them per call. The
/// PointInstancer instance arrays are never cached — they always sample the
/// requested time.
struct SkeletonFacts {
    prim: openusd::usd::Prim,
    type_name: String,
    renders_geometry: bool,
    /// Computed purpose is proxy/guide: the walk flattens the node's
    /// transform-possessed children up (decision is time-independent).
    excluded: bool,
    /// Has an Imageable view: only imageable prims get the per-call
    /// visibility read; non-imageable prims stay visible (fail-soft).
    imageable: bool,
    self_moves: bool,
    self_deforms: bool,
    /// The prim's local matrix when `self_moves` is false: nothing in its
    /// xformOpOrder samples, so one evaluation (at default time) holds for
    /// the whole stage. Only a static transform is cached — `None` also
    /// covers "not cacheable" (a moving prim) and `Unsupported`, so the
    /// walks fall back to a per-call `local_transform`.
    static_transform: Option<gf::Matrix4d>,
    /// The prim's computed visibility when nothing on its render path
    /// samples `visibility`: neither the prim nor any ancestor the walk
    /// threads down is visibility-animated, so one evaluation (at default
    /// time) holds for the whole stage. `None` also covers "not cacheable",
    /// so the walks fall back to the per-call read.
    static_visible: Option<bool>,
    /// The prim's overall `visibility` attr carries authored time samples:
    /// the per-call visibility read flips across times, so the delta walk
    /// must include the prim even when nothing else about it samples.
    self_visibility_animated: bool,
    /// Direct `material:binding` target, loaded for geometry prims exactly
    /// where the per-call walk used to look it up.
    material: Option<String>,
    /// Composed children in walk order, abstract prims excluded (the
    /// per-call `children()` enumeration and `is_abstract` filter, once).
    children: Vec<String>,
    kind: SkeletonKind,
}

/// Which child-producing branch the walk takes for this prim, decided at
/// build time from the prim's own composition (type instance state is not
/// time-sampleable): a PointInstancer's synthetic children, a native
/// instance's prototype expansion, or plain recursion.
enum SkeletonKind {
    Plain,
    NativeInstance { prototype: Option<sdf::Path> },
    PointInstancer { prototypes: Vec<sdf::Path> },
}

/// The stage-open manifest cache: every time-independent manifest fact,
/// built once, held in the stage-owner loop state, cleared on `Open` and on
/// every successful mutation like the MeshCache. Each manifest call reuses
/// the cached `static_transform` and `static_visible` and samples ONLY what
/// the build proved time-dependent: animated transforms, animated visibility
/// and the PointInstancer instance arrays.
struct ManifestSkeleton {
    /// Facts for every prim reachable from the pseudo-root plus every
    /// prototype subtree discovered along the way (native prototype roots
    /// live outside the pseudo-root namespace, so a flat map keyed by path
    /// reaches both). Values are keyed by their composed path spelling.
    facts: HashMap<String, SkeletonFacts>,
    root_children: Vec<String>,
    /// The unioned authored time-sample times of every animated
    /// attribute the walk found (ascending, deduped) — empty when
    /// nothing is time-sampled.
    time_codes: Vec<f64>,
    /// Whether a prim's RENDERED subtree (through native-instance
    /// expansions and PointInstancer prototypes) holds any time-dependent
    /// signal, own or descendant — the delta walk prunes whole subtrees
    /// without this reachability answer ever sampling them.
    signals: HashMap<String, bool>,
}

impl ManifestSkeleton {
    fn build(stage: &Stage) -> Result<ManifestSkeleton, String> {
        let mut skeleton = ManifestSkeleton {
            facts: HashMap::new(),
            root_children: Vec::new(),
            time_codes: Vec::new(),
            signals: HashMap::new(),
        };
        let mut skel_memo = SkelAnimMemo::new();
        // Every attribute the walk finds with authored time samples; the
        // post-walk union below derives `time_codes` from them.
        let mut sampled_attrs: Vec<Attribute> = Vec::new();
        let mut pending: Vec<sdf::Path> = Vec::new();
        let pseudo_root = stage
            .prim(sdf::Path::abs_root())
            .map_err(|e| format!("invalid pseudo-root path: {}", e))?;
        skeleton.root_children = build_facts(
            stage,
            &pseudo_root,
            &mut skeleton,
            &mut pending,
            &mut skel_memo,
            &mut sampled_attrs,
            false,
        )?;
        // Native prototype roots (and any prototype target outside the
        // walked tree) only exist as prims once their instances composed,
        // which the walk above just did — build their facts now, feeding
        // prototypes discovered inside prototype subtrees back into the
        // same queue.
        while let Some(path) = pending.pop() {
            let key = path.to_string();
            if skeleton.facts.contains_key(&key) {
                continue;
            }
            let prim = stage
                .prim(path.clone())
                .map_err(|e| format!("invalid prototype path '{}': {}", path, e))?;
            if !prim.is_valid().map_err(stage_err)? {
                continue;
            }
            // A prototype root reaches the build outside the walk, so the
            // recursion never threads its ancestors' visibility state: read
            // it from the stage instead.
            let ancestor_visibility_animated = ancestry_samples_visibility(stage, &path);
            build_facts(
                stage,
                &prim,
                &mut skeleton,
                &mut pending,
                &mut skel_memo,
                &mut sampled_attrs,
                ancestor_visibility_animated,
            )?;
        }
        skeleton.time_codes = Attribute::unioned_time_samples(&sampled_attrs).map_err(stage_err)?;
        for key in skeleton.facts.keys().cloned().collect::<Vec<String>>() {
            signal_of(&skeleton.facts, &key, &mut skeleton.signals);
        }
        Ok(skeleton)
    }

    fn signal(&self, key: &str) -> bool {
        self.signals.get(key).copied().unwrap_or(false)
    }
}

/// Facts for one prim and (recursively) its whole subtree, inserted keyed by
/// the composed path; returns the prim's children keys in walk order, so the
/// caller can link them. Discoveries that name prims outside the walked
/// namespace accumulate in `pending` for the post-walk fixpoint.
fn build_facts(
    stage: &Stage,
    prim: &openusd::usd::Prim,
    skeleton: &mut ManifestSkeleton,
    pending: &mut Vec<sdf::Path>,
    skel_memo: &mut SkelAnimMemo,
    sampled_attrs: &mut Vec<Attribute>,
    ancestor_visibility_animated: bool,
) -> Result<Vec<String>, String> {
    let type_name = prim
        .type_name()
        .map_err(stage_err)?
        .map(|t| t.to_string())
        .unwrap_or_default();
    let renders = renders_geometry(&type_name);
    let kind = if type_name == "PointInstancer" {
        // Same branch priority the per-call dispatcher had: the instancer
        // arm wins over native-instance expansion of the same prim.
        let prototypes = PointInstancer::from_prim_unchecked(prim.clone())
            .prototypes_rel()
            .forwarded_targets()
            .map_err(stage_err)?;
        pending.append(&mut prototypes.clone());
        SkeletonKind::PointInstancer { prototypes }
    } else if prim.is_instance().map_err(stage_err)? {
        // Native prototype roots live outside the walked namespace, so their
        // facts come from the post-walk fixpoint.
        let prototype = prim.prototype().map_err(stage_err)?;
        if let Some(path) = &prototype {
            pending.push(path.clone());
        }
        SkeletonKind::NativeInstance { prototype }
    } else {
        SkeletonKind::Plain
    };

    let (imageable, excluded) = match Imageable::from_prim(prim.clone()).map_err(stage_err)? {
        None => (false, false),
        Some(imageable) => (
            true,
            matches!(
                imageable.compute_purpose().map_err(stage_err)?,
                Purpose::Proxy | Purpose::Guide
            ),
        ),
    };
    let (self_moves, self_deforms, self_visibility_animated) =
        samples_scene_motion(prim, renders, imageable, skel_memo, sampled_attrs)?;
    // The walk threads this down as its `vis` force; the excluded lift and
    // the prototype expansions decide it their own way, so it is recorded
    // here as the union over the whole render path.
    let visibility_animated = ancestor_visibility_animated || self_visibility_animated;

    // Only plain prims recurse into prim children: an instance's prim
    // children are instance proxies (rendered via its prototype expansion,
    // never walked per instance) and a PointInstancer renders synthetic
    // children only. This keeps the build linear in walked prims, mirroring
    // what the per-call walk actually visits.
    let mut children = Vec::new();
    if matches!(kind, SkeletonKind::Plain) {
        for child in visible_children(prim)? {
            let child_key = child.path().to_string();
            build_facts(
                stage,
                &child,
                skeleton,
                pending,
                skel_memo,
                sampled_attrs,
                visibility_animated,
            )?;
            children.push(child_key);
        }
    }

    // A prim whose transform samples nothing keeps one local matrix for the
    // whole stage: evaluate it once here rather than on every walk step.
    let static_transform = if self_moves {
        None
    } else {
        local_transform(prim, None)?
    };
    // Same hoist for visibility: with nothing sampling on the render path,
    // one evaluation at default time holds for every queried time.
    let static_visible = if visibility_animated {
        None
    } else {
        Some(computed_visibility(prim, imageable, None)?)
    };

    let path = prim.path().to_string();
    skeleton.facts.insert(
        path,
        SkeletonFacts {
            prim: prim.clone(),
            type_name,
            renders_geometry: renders,
            excluded,
            imageable,
            self_moves,
            self_deforms,
            static_transform,
            static_visible,
            self_visibility_animated,
            material: if renders {
                direct_material(stage, prim)
            } else {
                None
            },
            children: children.clone(),
            kind,
        },
    );
    Ok(children)
}

/// Whether any real ancestor of a prim outside the walked tree samples
/// `visibility`: a prototype root's inherited visibility feeds its whole
/// subtree, and its own ancestry (the synthetic `/__Prototype_N` chain, or
/// the instancer above a PointInstancer prototype) is not reachable from
/// the recursion. A read error answers "yes": an uncached node only
/// recomputes at the use site.
fn ancestry_samples_visibility(stage: &Stage, path: &sdf::Path) -> bool {
    let mut ancestor = path.parent();
    while let Some(parent) = ancestor {
        ancestor = parent.parent();
        let Ok(prim) = stage.prim(parent) else {
            return true;
        };
        if !prim.is_valid().unwrap_or(false) {
            return true;
        }
        match prim.attribute("visibility").num_time_samples() {
            Ok(0) => {}
            _ => return true,
        }
    }
    false
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

/// One attribute pass over a prim for every animated signal at once:
/// `(moves transform, deforms geometry, visibility samples)` — the
/// manifest walk previously enumerated the composed attribute list twice
/// per prim with time-sample scans over every attribute, which measured
/// as the kitchen manifest's hot spot (2745 nodes × 29 attributes).
/// `renders_geometry` is the prim's type-gated decision: a non-geometry
/// prim's primvars can never animate rendered vertices, so its primvar
/// names skip the (composed, pricey) time-sample query; `imageable`
/// likewise gates the visibility check (a non-imageable prim's visibility
/// is never computed per call).
/// Geometry deformation covers points/normals/widths and primvars
/// (Task 6 ruling 1a) plus the topology attrs tessellation reads at the
/// requested time (faceVertexCounts/faceVertexIndices/curveVertexCounts); transform motion covers xformOps, the
/// PointInstancer's per-instance arrays, and — third flag — overall
/// `visibility` time samples (compute_visibility stays per-call). Attributes outside any
/// family skip the time-sample query.
fn samples_scene_motion(
    prim: &openusd::usd::Prim,
    renders_geometry: bool,
    imageable: bool,
    skel_memo: &mut SkelAnimMemo,
    sampled_attrs: &mut Vec<Attribute>,
) -> Result<(bool, bool, bool), String> {
    let is_instancer = prim
        .type_name()
        .map_err(stage_err)?
        .is_some_and(|token| token == "PointInstancer");
    let mut transform = false;
    let mut geometry = false;
    let mut visibility = false;
    // UsdSkel influence membership: a skel-bound geometry prim's points
    // can be driven by the bound animation even with no sampled primvar
    // (the only authored-name check the non-skel budget allows; the
    // resolution below runs solely on the rare hit).
    let mut skel_influences = false;
    // authored_property_names (composed authored names, no schema-declared
    // expansion) is the enumeration the manifest walk can afford — measured
    // ~27x cheaper than attributes() on Kitchen_set_instanced, and a
    // schema-declared yet unauthored attribute can never carry time samples.
    for name in prim.authored_property_names().map_err(stage_err)? {
        let name = name.as_str();
        if renders_geometry && !skel_influences && name == "primvars:skel:jointIndices" {
            skel_influences = true;
        }
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
        let visibility_samples = imageable && name == "visibility";
        if !moves_transform && !deforms_geometry && !visibility_samples {
            continue;
        }
        let attribute = prim.attribute(name);
        if attribute.num_time_samples().map_err(stage_err)? == 0 {
            continue;
        }
        sampled_attrs.push(attribute);
        if moves_transform {
            transform = true;
        }
        if deforms_geometry {
            geometry = true;
        }
        if visibility_samples {
            visibility = true;
        }
    }
    if skel_influences {
        // A broken skel binding fails soft here (mirrors direct_material):
        // the flag only controls refetching, and tessellation reports the
        // binding error when the geometry is actually fetched.
        match skel_joint_transforms_vary(prim, skel_memo) {
            Ok(varying) => geometry |= varying,
            Err(error) => eprintln!(
                "usdbee: ignoring skel binding at {}: {}",
                prim.path(),
                error
            ),
        }
    }
    Ok((transform, geometry, visibility))
}

/// Whether the rendered subtree rooted at `key` carries any time-dependent
/// signal — the prim's own motion/deformation/visibility sampling or any
/// descendant's, through the two synthetic child sources (native-instance
/// expansions draw the prototype's CHILDREN, so only they feed the signal;
/// a PointInstancer's synthetic child draws the prototype ROOT itself, so
/// its own signal counts). USD composition is acyclic, so the recursion
/// terminates; the pre-seeded false guards a pathological cycle fail-soft.
fn signal_of(
    facts: &HashMap<String, SkeletonFacts>,
    key: &str,
    memo: &mut HashMap<String, bool>,
) -> bool {
    if let Some(cached) = memo.get(key) {
        return *cached;
    }
    memo.insert(key.to_string(), false);
    let Some(fact) = facts.get(key) else {
        return false;
    };
    let mut signal = fact.self_moves || fact.self_deforms || fact.self_visibility_animated;
    let descendants: Vec<String> = match &fact.kind {
        SkeletonKind::Plain => fact.children.clone(),
        SkeletonKind::NativeInstance { prototype } => {
            // The prototype ROOT is consumed like a child: its self_moves
            // lifts the copies' animated flag, its own sampled visibility
            // flips every copy's computed visibility (the copies are its
            // descendants), and its deforms drive the instance node's own
            // geometry — so its signals must count for the instance even
            // when the instance prim's composed attrs miss them.
            let mut descendants = Vec::new();
            if let Some(path) = prototype {
                descendants.push(path.to_string());
                if let Some(proto) = facts.get(&path.to_string()) {
                    descendants.extend(proto.children.clone());
                }
            }
            descendants
        }
        SkeletonKind::PointInstancer { prototypes } => {
            prototypes.iter().map(|path| path.to_string()).collect()
        }
    };
    for descendant in descendants {
        signal |= signal_of(facts, &descendant, memo);
    }
    memo.insert(key.to_string(), signal);
    signal
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
///
/// `walk` selects the per-prototype SUBTREE builder and the zero-instance
/// wrapper policy: a full-manifest walk uses full subtrees and skips
/// zero-instance prototypes; a delta walk always keeps zero-instance
/// wrappers in the output with `instances: []` and `visible: false`, so
/// the frontend's in-place update hides a count that dropped to zero —
/// the pinned invariant that a delta-present instancer carries every
/// synthetic child wrapper. Within a delta walk, a synthetic child whose
/// own `animated` flag is set (its descendant InstancedMeshes re-derive
/// their per-instance matrices from the threaded context every step) or a
/// visibility-forced walk (whose descendants' baked visible flags may
/// flip) keeps the FULL subtree, while a connector filters to its
/// signal-bearing nodes.
#[derive(Clone, Copy)]
enum ProtoWalk {
    /// The full manifest walk: full subtrees, no zero-instance wrappers.
    Full,
    /// Delta over an instancer whose context moves: full subtrees, and
    /// zero-instance wrappers as hide carriers.
    DeltaFull,
    /// Delta connector: filtered subtrees (`vis` is the delta walk's
    /// visibility force), zero-instance wrappers as hide carriers.
    DeltaFiltered { vis: bool },
}

fn prototype_children(
    skeleton: &ManifestSkeleton,
    prim: &openusd::usd::Prim,
    prototypes: &[sdf::Path],
    time: Option<f64>,
    instancer_moves: bool,
    ctx: &mut WalkCtx<'_>,
    walk: ProtoWalk,
) -> Result<Vec<RenderNode>, String> {
    let instancer = PointInstancer::from_prim_unchecked(prim.clone());
    let time_code = time.map(TimeCode::new);
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
        // A prototype target that composed no prototype renders nothing (the
        // walk used to skip it through an is_valid check); skeleton build
        // leaves such paths without facts.
        let Some(prototype) = skeleton.facts.get(&prototype_path.to_string()) else {
            continue;
        };
        // An excluded prototype ROOT still emits its synthetic node (with
        // its own geometry suppressed): descendants traverse with their own
        // computed purpose deciding, mirroring render_children's Exclude
        // arm for ordinary parents. The root's geometry must not draw, so
        // has_geometry clears when the root is excluded. Purpose is a
        // cached fact; visibility samples the requested time (the root's own
        // flag is evaluated per instance, never from the build's cache).
        let (excluded, visible) = if prototype.excluded {
            (true, true)
        } else {
            (
                false,
                computed_visibility(&prototype.prim, prototype.imageable, time)?,
            )
        };
        let type_name = prototype.type_name.clone();
        // A prototype root whose own xformOpOrder samples moves: the build
        // leaves its static transform unset, so the per-time read stands in.
        let proto_xform = node_transform(prototype, time, ctx.transforms)?;
        // The prototype root's own xform is folded into every
        // instance matrix, so sampled proto xformOps animate the
        // child as much as the instancer's own arrays do.
        let proto_renders_geometry = prototype.renders_geometry;
        let (proto_moves, proto_deforms) = (prototype.self_moves, prototype.self_deforms);
        let animated = instancer_moves || proto_moves || (proto_renders_geometry && proto_deforms);
        // The synthetic node fetches the prototype ROOT's geometry (the
        // one cache entry keyed by its resolved path), so only the root's
        // own sampled geometry attrs count here — its descendants carry
        // their own per-node flags from the walked subtree below.
        let geometry_animated = proto_renders_geometry && proto_deforms;
        // The delta subtree filter only applies to a connector synthetic
        // child (nothing of its own animates): an animated one re-derives
        // every descendant matrix per step, and a visibility-forced walk
        // carries stale baked visible flags, so both stay full.
        let mode = match walk {
            ProtoWalk::Full | ProtoWalk::DeltaFull => SubtreeMode::Full,
            ProtoWalk::DeltaFiltered { vis } => {
                if animated || vis {
                    SubtreeMode::Full
                } else {
                    SubtreeMode::DeltaFiltered { vis: false }
                }
            }
        };
        let emit_empty = !matches!(walk, ProtoWalk::Full);
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
        if instances.is_empty() && !emit_empty {
            continue;
        }
        let synthetic_path = format!("{}/{}{}", prim.path(), PROTO_PREFIX, index);
        // A zero-instance wrapper is the hide carrier (visible: false,
        // no subtree): the frontend sets its wrapper invisible, which
        // cascades to threaded descendants; the count returns when the
        // instancer re-emits it with instances.
        let (visible, mut prototype_children) = if instances.is_empty() {
            (false, Vec::new())
        } else {
            (
                visible,
                build_subtree(mode, skeleton, &prototype.children, time, animated, ctx)?,
            )
        };
        rebase_render_paths(
            &mut prototype_children,
            prototype_path,
            &sdf::try_into_path(synthetic_path.as_str())
                .map_err(|e| format!("invalid synthetic prototype path: {}", e))?,
        )?;
        children.push(RenderNode {
            path: synthetic_path,
            name: format!("{}{}", PROTO_PREFIX, index),
            material: direct_material(prim.stage(), &prototype.prim),
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
/// (prototype path, ancestor-moves, walk mode): identical compositions
/// share one prototype, so the tree is walked once and cloned per
/// instance. The ancestor-moves variant of the animated flag keeps the
/// two states apart, and the walk mode keeps a full-walk entry from being
/// reused by a filtered delta walk (or vice versa) within one request.
type PrototypeMemo = HashMap<(sdf::Path, bool, SubtreeMode), Vec<RenderNode>>;

/// Per-walk state threaded through the manifest recursion: the prototype
/// subtrees this call already built, and the owner's (prim, time) -> matrix
/// memo. They travel together because every level of the walk needs both.
struct WalkCtx<'a> {
    prototypes: PrototypeMemo,
    transforms: &'a mut TransformMemo,
}

impl<'a> WalkCtx<'a> {
    fn new(transforms: &'a mut TransformMemo) -> Self {
        Self {
            prototypes: PrototypeMemo::new(),
            transforms,
        }
    }
}

/// Which walk builds a prototype subtree: the full walk (every node) or
/// the delta walk filtered to signal-bearing nodes. `vis` is the delta
/// walk's visibility force — see `delta_children`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum SubtreeMode {
    Full,
    DeltaFiltered { vis: bool },
}

fn build_subtree(
    mode: SubtreeMode,
    skeleton: &ManifestSkeleton,
    children: &[String],
    time: Option<f64>,
    ancestor_moves: bool,
    ctx: &mut WalkCtx<'_>,
) -> Result<Vec<RenderNode>, String> {
    match mode {
        SubtreeMode::Full => render_children(skeleton, children, time, ancestor_moves, ctx),
        SubtreeMode::DeltaFiltered { vis } => {
            delta_children(skeleton, children, time, ancestor_moves, ctx, false, vis)
        }
    }
}

fn native_prototype_children(
    skeleton: &ManifestSkeleton,
    instance: &openusd::usd::Prim,
    prototype: Option<&sdf::Path>,
    time: Option<f64>,
    ancestor_moves: bool,
    ctx: &mut WalkCtx<'_>,
    mode: SubtreeMode,
) -> Result<Vec<RenderNode>, String> {
    let Some(prototype_path) = prototype else {
        return Ok(Vec::new());
    };
    // The prototype subtree is identical for every instance sharing one
    // prototype (pcp mints the prototype exactly when compositions agree),
    // so its rendered tree is walked once per (prototype, ancestor-moves,
    // walk mode) and cloned per instance — only the path rebase differs.
    // The memo is per-call state: its entries hold sampled transforms and
    // visibility, so they must not outlive the manifest call that built them.
    let memo_key = (prototype_path.clone(), ancestor_moves, mode);
    // Taken out of the ctx before the miss arm rebuilds it: the arm needs the
    // whole ctx mutably.
    let cached = ctx.prototypes.get(&memo_key).cloned();
    let mut raw = match cached {
        Some(children) => children,
        None => {
            let prototype = skeleton
                .facts
                .get(&prototype_path.to_string())
                .ok_or_else(|| {
                    format!(
                        "cached manifest facts missing for prototype {}",
                        prototype_path
                    )
                })?;
            let moves = ancestor_moves || prototype.self_moves;
            let children = build_subtree(mode, skeleton, &prototype.children, time, moves, ctx)?;
            ctx.prototypes.insert(memo_key.clone(), children.clone());
            children
        }
    };
    rebase_render_paths(&mut raw, prototype_path, instance.path())?;
    Ok(raw)
}

fn render_node_children(
    skeleton: &ManifestSkeleton,
    facts: &SkeletonFacts,
    time: Option<f64>,
    ancestor_moves: bool,
    ctx: &mut WalkCtx<'_>,
) -> Result<Vec<RenderNode>, String> {
    match &facts.kind {
        SkeletonKind::PointInstancer { prototypes } => prototype_children(
            skeleton,
            &facts.prim,
            prototypes,
            time,
            ancestor_moves,
            ctx,
            ProtoWalk::Full,
        ),
        SkeletonKind::NativeInstance { prototype } => native_prototype_children(
            skeleton,
            &facts.prim,
            prototype.as_ref(),
            time,
            ancestor_moves,
            ctx,
            SubtreeMode::Full,
        ),
        SkeletonKind::Plain => {
            render_children(skeleton, &facts.children, time, ancestor_moves, ctx)
        }
    }
}

fn render_children(
    skeleton: &ManifestSkeleton,
    children: &[String],
    time: Option<f64>,
    ancestor_moves: bool,
    ctx: &mut WalkCtx<'_>,
) -> Result<Vec<RenderNode>, String> {
    let mut nodes = Vec::new();
    for child in children {
        let facts = skeleton
            .facts
            .get(child)
            .ok_or_else(|| format!("cached manifest facts missing for prim {}", child))?;
        let deforms = facts.renders_geometry && facts.self_deforms;
        let moves = ancestor_moves || facts.self_moves;
        let transform = node_transform(facts, time, ctx.transforms)?;
        if facts.excluded {
            // Purpose proxy/guide is a cached fact: the prim itself emits
            // nothing and its descendants flatten up with its transform
            // composed in — but they still need this call's sampling.
            let mut descendants = render_node_children(skeleton, facts, time, moves, ctx)?;
            for descendant in &mut descendants {
                descendant.transform = (transform * gf::Matrix4d(descendant.transform)).0;
            }
            nodes.extend(descendants);
            continue;
        }
        // Visibility is time-dependent by USD semantics — the cached value
        // only stands in when the build proved nothing on the render path
        // samples it.
        let visible = node_visible(facts, time, false)?;
        let node_children = render_node_children(skeleton, facts, time, moves, ctx)?;
        let node = RenderNode {
            material: facts.material.clone(),
            path: child.clone(),
            name: facts.prim.path().name().unwrap_or_default().to_string(),
            has_geometry: facts.renders_geometry,
            type_name: facts.type_name.clone(),
            animated: deforms || moves,
            geometry_animated: deforms,
            instances: Vec::new(),
            transform: transform.0,
            visible,
            children: node_children,
        };
        nodes.push(node);
    }
    Ok(nodes)
}

/// The time-delta manifest walk (playback/scrub): emits ONLY nodes with a
/// time-dependent signal — sampled xformOps, sampled geometry attrs,
/// sampled overall visibility, or (through self_moves) a PointInstancer's
/// sampled arrays — plus the CONNECTOR ancestors an in-place update needs.
/// The frontend applies node transforms as LOCAL matrices, so static
/// descendants of a moving prim follow their parent for free; a subtree
/// with no signal anywhere is skipped whole, never sampled.
///
/// `force` covers the one exception: a purpose-proxy/guide (excluded) prim
/// emits nothing itself and lifts its descendants with its transform
/// composed into their LOCAL matrices — when IT moves (or its own
/// visibility samples, flipping the lifted descendants' computed
/// visibility), those descendants must ride along. Force applies per
/// level only: once a node is emitted as a real object, its static
/// children follow through three.js parenting, so it never propagates
/// past a plain node (only through excluded chains, which keep composing).
///
/// `vis` propagates without bound: the full walk bakes each node's
/// INHERITED computed visibility into its `visible` flag, so whenever an
/// ancestor's visibility samples, every descendant's baked flag can flip
/// with time — they all ride the delta with a freshly computed `visible`,
/// through instance expansions and prototype subtrees alike.
fn delta_children(
    skeleton: &ManifestSkeleton,
    children: &[String],
    time: Option<f64>,
    ancestor_moves: bool,
    ctx: &mut WalkCtx<'_>,
    force: bool,
    vis: bool,
) -> Result<Vec<RenderNode>, String> {
    let mut nodes = Vec::new();
    for child in children {
        let facts = skeleton
            .facts
            .get(child)
            .ok_or_else(|| format!("cached manifest facts missing for prim {}", child))?;
        let deforms = facts.renders_geometry && facts.self_deforms;
        let self_animated = facts.self_moves || deforms || facts.self_visibility_animated;
        if !(force || vis || self_animated || skeleton.signal(child)) {
            continue;
        }
        let moves = ancestor_moves || facts.self_moves;
        let transform = node_transform(facts, time, ctx.transforms)?;
        if facts.excluded {
            // The lift composes this transform into the descendants' local
            // matrices, so its own motion forces the whole level along; its
            // own visibility samples flip the lifted descendants' computed
            // visibility, so they ride along too.
            let mut descendants = delta_node_children(
                skeleton,
                facts,
                time,
                moves,
                ctx,
                force || facts.self_moves || facts.self_visibility_animated,
                vis,
            )?;
            for descendant in &mut descendants {
                descendant.transform = (transform * gf::Matrix4d(descendant.transform)).0;
            }
            nodes.extend(descendants);
            continue;
        }
        // Visibility is time-dependent by USD semantics — the cached value
        // only stands in while no ancestor forces `vis` and the build could
        // cache it.
        let visible = node_visible(facts, time, vis)?;
        let node_children = delta_node_children(
            skeleton,
            facts,
            time,
            moves,
            ctx,
            false,
            vis || facts.self_visibility_animated,
        )?;
        let node = RenderNode {
            material: facts.material.clone(),
            path: child.clone(),
            name: facts.prim.path().name().unwrap_or_default().to_string(),
            has_geometry: facts.renders_geometry,
            type_name: facts.type_name.clone(),
            animated: deforms || moves,
            geometry_animated: deforms,
            instances: Vec::new(),
            transform: transform.0,
            visible,
            children: node_children,
        };
        nodes.push(node);
    }
    Ok(nodes)
}

fn delta_node_children(
    skeleton: &ManifestSkeleton,
    facts: &SkeletonFacts,
    time: Option<f64>,
    ancestor_moves: bool,
    ctx: &mut WalkCtx<'_>,
    force: bool,
    vis: bool,
) -> Result<Vec<RenderNode>, String> {
    match &facts.kind {
        SkeletonKind::PointInstancer { prototypes } => {
            // emit_all: the frontend hides a delta instancer's absent
            // synthetic children, so whenever the instancer node itself is
            // in the delta every currently-drawn child must come along.
            let emit_all = force || facts.self_moves || facts.self_visibility_animated || vis;
            if !emit_all && !prototypes.iter().any(|path| skeleton.signal(path.as_str())) {
                return Ok(Vec::new());
            }
            delta_prototype_children(
                skeleton,
                &facts.prim,
                prototypes,
                time,
                ancestor_moves,
                ctx,
                vis,
            )
        }
        SkeletonKind::NativeInstance { prototype } => {
            // `force` must thread: an excluded native instance lifts its
            // copies with the excluded chain's transform composed in, so
            // when the chain moves the copies must ride with rebuilt local
            // matrices. The prototype ROOT's own visibility samples flip
            // every copy's computed visibility even when the instance
            // prim's composed attrs miss them.
            let root_vis = prototype
                .as_ref()
                .and_then(|path| skeleton.facts.get(&path.to_string()))
                .is_some_and(|proto| proto.self_visibility_animated);
            native_prototype_children(
                skeleton,
                &facts.prim,
                prototype.as_ref(),
                time,
                ancestor_moves,
                ctx,
                SubtreeMode::DeltaFiltered {
                    vis: vis || force || root_vis,
                },
            )
        }
        SkeletonKind::Plain => delta_children(
            skeleton,
            &facts.children,
            time,
            ancestor_moves,
            ctx,
            force,
            vis,
        ),
    }
}

/// Delta walk over one PointInstancer's synthetic children. When the
/// instancer's context moves (`instancer_moves` — its own sampled arrays
/// or any sampled ancestor xform), every synthetic child and its whole
/// subtree re-derive per step, so the full walk output IS the delta.
/// Otherwise the instancer sits in the delta as a connector (an
/// excluded-ancestor lift, its own visibility samples, or a prototype
/// subtree carrying a signal): then every synthetic child wrapper is
/// emitted — zero-instance ones included, as `visible: false` hide
/// carriers, so the frontend's in-place update hides a count that dropped
/// — with non-animated subtrees filtered to their signal-bearing nodes.
fn delta_prototype_children(
    skeleton: &ManifestSkeleton,
    prim: &openusd::usd::Prim,
    prototypes: &[sdf::Path],
    time: Option<f64>,
    instancer_moves: bool,
    ctx: &mut WalkCtx<'_>,
    vis: bool,
) -> Result<Vec<RenderNode>, String> {
    let walk = if instancer_moves {
        ProtoWalk::DeltaFull
    } else {
        ProtoWalk::DeltaFiltered { vis }
    };
    prototype_children(skeleton, prim, prototypes, time, instancer_moves, ctx, walk)
}

/// Computed visibility at the requested time — the per-time imageable
/// query (Task 1: compute_visibility must stay per-time; only the build's
/// `static_visible` may stand in for it). Non-imageable prims stay visible,
/// matching the old renderable_state semantics).
fn computed_visibility(
    prim: &openusd::usd::Prim,
    imageable: bool,
    time: Option<f64>,
) -> Result<bool, String> {
    if !imageable {
        return Ok(true);
    }
    let imageable = Imageable::from_prim(prim.clone())
        .map_err(stage_err)?
        .ok_or_else(|| {
            format!(
                "imageable view missing for {} at manifest cache build",
                prim.path()
            )
        })?;
    Ok(imageable
        .compute_visibility(time.map(TimeCode::new))
        .map_err(stage_err)?
        != Visibility::Invisible)
}

/// The node's `visible` flag: the build's static value unless the walk is
/// forcing visibility down this level (`forced`, the delta walk's `vis`),
/// else the per-call read.
fn node_visible(facts: &SkeletonFacts, time: Option<f64>, forced: bool) -> Result<bool, String> {
    match facts.static_visible {
        Some(visible) if !forced => Ok(visible),
        _ => computed_visibility(&facts.prim, facts.imageable, time),
    }
}

/// The node's local matrix at `time`: the build's static value when the prim's
/// xformOps author no samples, else the memoized per-time read. `Unsupported`
/// keeps the old use-site fallback (identity).
fn node_transform(
    facts: &SkeletonFacts,
    time: Option<f64>,
    transforms: &mut TransformMemo,
) -> Result<gf::Matrix4d, String> {
    if let Some(matrix) = facts.static_transform {
        return Ok(matrix);
    }
    let path = facts.prim.path();
    if let Some(matrix) = transforms.get(path.as_str(), time) {
        return Ok(*matrix);
    }
    let matrix = local_transform(&facts.prim, time)?.unwrap_or(gf::Matrix4d::IDENTITY);
    transforms.insert(
        path.to_string(),
        time,
        matrix,
        std::mem::size_of::<gf::Matrix4d>(),
    );
    Ok(matrix)
}

pub fn serialize_render_manifest(
    stage: &Stage,
    time: Option<f64>,
) -> Result<Vec<RenderNode>, String> {
    // The stage-owner thread builds the skeleton once per stage-open and
    // reuses it; this free entry point (used by tests and any direct caller)
    // rebuilds it per call so the walk stays self-contained. Output shape
    // and semantics are unchanged either way — a pure perf refactor.
    let skeleton = ManifestSkeleton::build(stage)?;
    let mut transforms = new_transform_memo();
    let mut ctx = WalkCtx::new(&mut transforms);
    render_children(&skeleton, &skeleton.root_children, time, false, &mut ctx)
}

pub fn serialize_animated_manifest(
    stage: &Stage,
    time: Option<f64>,
) -> Result<Vec<RenderNode>, String> {
    let skeleton = ManifestSkeleton::build(stage)?;
    let mut transforms = new_transform_memo();
    let mut ctx = WalkCtx::new(&mut transforms);
    delta_children(
        &skeleton,
        &skeleton.root_children,
        time,
        false,
        &mut ctx,
        false,
        false,
    )
}

/// Owner-thread cache keyed by (prim path, queried time), evicted oldest
/// first, under a byte budget and an entry ceiling. Both users are fed in
/// authored-time order by playback, where insertion order is as good as
/// least-recently-used and costs nothing per hit, so a hit does not refresh
/// an entry's position: re-insertion on write already does.
///
/// The time bits bucket first (`Option<f64>` is not `Hash`, and NaN keys
/// would be ambiguous), so a hit resolves the path through `&str` and the
/// memo's hot read (`node_transform`) allocates nothing.
struct KeyedCache<V> {
    // Each entry carries its own charge, so a refresh can credit the old one.
    time_buckets: HashMap<Option<u64>, HashMap<String, (V, usize)>>,
    order: VecDeque<(String, Option<u64>)>,
    bytes: usize,
    len: usize,
    byte_budget: usize,
    entry_ceiling: usize,
}

impl<V> KeyedCache<V> {
    fn with_limits(byte_budget: usize, entry_ceiling: usize) -> Self {
        Self {
            time_buckets: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            len: 0,
            byte_budget,
            entry_ceiling,
        }
    }

    fn get(&self, path: &str, time: Option<f64>) -> Option<&V> {
        self.time_buckets
            .get(&time.map(f64::to_bits))?
            .get(path)
            .map(|(value, _)| value)
    }

    /// Insert (or refresh) one entry charged `bytes`, then evict the oldest
    /// entries until both limits hold again. The newest entry always stays,
    /// even when it alone exceeds the budget: the caller just asked for it.
    fn insert(&mut self, path: String, time: Option<f64>, value: V, bytes: usize) {
        let bits = time.map(f64::to_bits);
        if let Some((_, previous)) = self
            .time_buckets
            .entry(bits)
            .or_default()
            .insert(path.clone(), (value, bytes))
        {
            // A refresh keeps its place in the queue.
            self.bytes = self.bytes - previous + bytes;
        } else {
            self.order.push_back((path, bits));
            self.bytes += bytes;
            self.len += 1;
        }
        while self.len > 1 && (self.bytes > self.byte_budget || self.len > self.entry_ceiling) {
            let Some((path, bits)) = self.order.pop_front() else {
                break;
            };
            let Some(bucket) = self.time_buckets.get_mut(&bits) else {
                continue;
            };
            if let Some((_, freed)) = bucket.remove(&path) {
                self.bytes -= freed;
                self.len -= 1;
            }
            if bucket.is_empty() {
                self.time_buckets.remove(&bits);
            }
        }
    }

    fn clear(&mut self) {
        self.time_buckets.clear();
        self.order.clear();
        self.bytes = 0;
        self.len = 0;
    }

    fn len(&self) -> usize {
        self.len
    }

    fn is_empty(&self) -> bool {
        self.len == 0
    }
}

/// Tessellation cache owned by the stage-owner thread: (prim path, time as
/// queried) -> the prim's packed geometry. `None` and `Some(t)` are distinct
/// keys. The packed form is cached rather than the mesh: every reader wants
/// those bytes, and re-packing a hit (a byte-wise per-vertex loop in
/// unoptimized builds, 6.3 ms per 14-prim batch in dev) was pure waste. The
/// charge is the packed length, the same order as `MeshData::size_bytes`
/// (identical arrays behind a 20-byte header).
pub struct MeshCache {
    entries: KeyedCache<Arc<[u8]>>,
    // Shared with StageState so tessellation-filling work can be counted
    // from outside the owner thread.
    tessellations: Arc<AtomicUsize>,
}

impl Default for MeshCache {
    fn default() -> Self {
        Self::new()
    }
}

impl MeshCache {
    // The budget must hold a full animation loop, or playback thrashes: the
    // CarbonFrameBike authors 281 time codes for 14 deforming prims (3,934
    // entries, 150.7 MiB of MeshData measured, capacities included), and a
    // mid-loop clear made every step re-tessellate all 14 (54 ms/step in dev,
    // 4.6 ms in release). 256 MiB fits that loop with headroom; the entry
    // ceiling bounds a scene of many tiny meshes (8,192 holds the loop's
    // 3,934 entries and Kitchen_set_instanced's 1,462 prototype meshes).
    const BYTE_BUDGET: usize = 256 * 1024 * 1024;
    const ENTRY_CEILING: usize = 8192;

    pub fn new() -> Self {
        Self::with_counter(Arc::new(AtomicUsize::new(0)))
    }

    pub fn with_counter(counter: Arc<AtomicUsize>) -> Self {
        Self {
            entries: KeyedCache::with_limits(Self::BYTE_BUDGET, Self::ENTRY_CEILING),
            tessellations: counter,
        }
    }

    pub fn get(&self, path: &str, time: Option<f64>) -> Option<Arc<[u8]>> {
        self.entries.get(path, time).cloned()
    }

    pub fn insert(&mut self, path: String, time: Option<f64>, packed: Arc<[u8]>) {
        self.tessellations.fetch_add(1, Ordering::Relaxed);
        let bytes = packed.len();
        self.entries.insert(path, time, packed, bytes);
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

/// Owner-thread cache of fully assembled pose frames keyed by their exact
/// queried time (`None` or the f64 bits; exact keys are as safe here as in
/// the MeshCache because playback asks for authored time codes). A warm pose
/// used to re-walk the 190-node delta tree, re-pack the deforming mesh and
/// copy the frame twice, all from data the other caches already held
/// (2.9 ms/pose in dev); the response bytes are a pure function of
/// (stage, time) for as long as those caches stand, so the whole frame is
/// what gets cached. A hit is a map lookup and the one copy the reply needs.
pub struct PoseFrameCache {
    entries: KeyedCache<Arc<[u8]>>,
    // Shared with StageState so a hit can be counted from outside the owner
    // thread (the timing-independent proof the dedup pins use).
    hits: Arc<AtomicUsize>,
}

impl Default for PoseFrameCache {
    fn default() -> Self {
        Self::new()
    }
}

impl PoseFrameCache {
    // Measured on the bike (190 delta nodes, one deforming prim): a frame is
    // ~15 KiB of node table + path and material tables plus ~24 KiB of
    // geometry, call it 45 KiB. 64 MiB holds ~1,450 frames, i.e. five full
    // passes over the clip's 281 authored codes, so a loop replayed twice
    // never re-assembles a frame it already has. The entry ceiling bounds a
    // scene of many tiny frames; the byte budget binds first on real ones.
    const BYTE_BUDGET: usize = 64 * 1024 * 1024;
    const ENTRY_CEILING: usize = 4096;

    pub fn new() -> Self {
        Self::with_counter(Arc::new(AtomicUsize::new(0)))
    }

    pub fn with_counter(hits: Arc<AtomicUsize>) -> Self {
        Self {
            entries: KeyedCache::with_limits(Self::BYTE_BUDGET, Self::ENTRY_CEILING),
            hits,
        }
    }

    /// The counter-free constructor the eviction pins drive with tiny limits.
    #[cfg(test)]
    fn with_limits(byte_budget: usize, entry_ceiling: usize) -> Self {
        Self {
            entries: KeyedCache::with_limits(byte_budget, entry_ceiling),
            hits: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn get(&mut self, time: Option<f64>) -> Option<Arc<[u8]>> {
        match self.entries.get(POSE_FRAME_PATH, time).cloned() {
            Some(frame) => {
                self.hits.fetch_add(1, Ordering::Relaxed);
                Some(frame)
            }
            None => None,
        }
    }

    fn insert(&mut self, time: Option<f64>, frame: Arc<[u8]>) {
        let bytes = frame.len();
        self.entries
            .insert(POSE_FRAME_PATH.to_string(), time, frame, bytes);
    }

    fn clear(&mut self) {
        self.entries.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Pose frames are keyed by time alone; the path half of the keyed cache
/// stays empty. One stage per owner thread, so no path discriminator is
/// needed.
const POSE_FRAME_PATH: &str = "";

/// Owner-thread memo of sampled local matrices: (prim path, queried time) ->
/// matrix. The skeleton hoists every prim whose xformOps author no samples
/// (`SkeletonFacts::static_transform`); this covers the animated half, which
/// would otherwise re-compose `xformOpOrder` and every op on each walk step
/// (174 of the bike's 190 delta nodes, 112 ms/step in dev, 2.4 ms in
/// release). Same lifecycle as the MeshCache: cleared on `Open` and by every
/// mutation — `warm_xform_keep` included, since a default-time xform write
/// is exactly what can falsify an entry.
type TransformMemo = KeyedCache<gf::Matrix4d>;

fn new_transform_memo() -> TransformMemo {
    // A bike loop is 174 animated prims x 281 codes = 48,894 entries, ~10 MiB
    // with keys; 64 MiB / 131,072 entries holds several such loops of
    // authored codes without ever clearing, and eviction only costs a
    // recomputed matrix.
    KeyedCache::with_limits(64 * 1024 * 1024, 131_072)
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

/// Requested-path -> resolved geometry/material key, owner-thread state so
/// identical prototype rebases across copies, batches and playback steps are
/// map lookups instead of recomposed prim walks (0.4 ms measured each); Ok
/// results only — a failed request keeps its readable error every time.
struct ResolveMemo {
    by_path: HashMap<String, String>,
}

impl ResolveMemo {
    fn new() -> Self {
        Self {
            by_path: HashMap::new(),
        }
    }

    fn clear(&mut self) {
        self.by_path.clear();
    }
}

/// Resolve a frontend-requested prim path for the geometry/material arms,
/// through the per-stage-open memo.
fn resolved_render_path(
    stage: &Stage,
    memo: &mut ResolveMemo,
    path: &str,
) -> Result<sdf::Path, String> {
    match memo.by_path.get(path) {
        Some(resolved) => sdf::try_into_path(resolved.as_str())
            .map_err(|e| format!("invalid memoized path '{}': {}", resolved, e)),
        None => {
            let resolved = resolve_render_path(stage, path)?;
            memo.by_path.insert(path.to_owned(), resolved.to_string());
            Ok(resolved)
        }
    }
}

/// Framed multi-slot geometry response (Phase 2.5 Task 3): little-endian
/// u32 batch magic "USBG" (0x5553_4247), version 1, slot count, then per
/// slot a status (0 ok / 1 err) + byte length + bytes, padded with zeros
/// to a 4-byte multiple. The padding keeps every slot payload (and thus
/// the next slot header) at a 4-byte-aligned offset, which the frontend
/// typed-array views in decodeGeometry require; the length field stays
/// the real payload length and the decoder skips the padding itself.
/// Mirrored by src/lib/render/geometryDecoder.ts.
const BATCH_MAGIC: u32 = 0x5553_4247;
const BATCH_VERSION: u32 = 1;

fn frame_batch<S: AsRef<[u8]>>(slots: Vec<Result<S, String>>) -> Vec<u8> {
    let payload: usize = slots
        .iter()
        .map(|slot| match slot {
            Ok(bytes) => bytes.as_ref().len(),
            Err(error) => error.len(),
        })
        .sum();
    let mut out = Vec::with_capacity(12 + slots.len() * 8 + payload);
    write_batch(&mut out, &slots);
    out
}

/// The batch envelope and its slots, written straight into `out`: the pose
/// frame calls this last so its geometry lands in the final buffer instead of
/// a batch buffer that is then copied behind the node table.
fn write_batch<S: AsRef<[u8]>>(out: &mut Vec<u8>, slots: &[Result<S, String>]) {
    out.extend(BATCH_MAGIC.to_le_bytes());
    out.extend(BATCH_VERSION.to_le_bytes());
    out.extend((slots.len() as u32).to_le_bytes());
    for slot in slots {
        match slot {
            Ok(bytes) => {
                let bytes = bytes.as_ref();
                out.extend(0u32.to_le_bytes());
                out.extend((bytes.len() as u32).to_le_bytes());
                out.extend(bytes);
            }
            Err(error) => {
                out.extend(1u32.to_le_bytes());
                out.extend((error.len() as u32).to_le_bytes());
                out.extend(error.as_bytes());
            }
        }
        // USDB frames are already a multiple of 4 (u32 header + f32/u32
        // data), but error messages are arbitrary UTF-8; zero-pad so slot
        // boundaries never depend on payload alignment.
        pad_to_4(out);
    }
}

/// Zero-pad to the next 4-byte boundary. Every length prefix in these frames
/// carries the true byte count, so the padding is implicit (`align4(len)`) and
/// a reader can view the body in place with 4-byte-typed views.
fn pad_to_4(out: &mut Vec<u8>) {
    let pad = (4 - out.len() % 4) % 4;
    out.extend(std::iter::repeat_n(0u8, pad));
}

/// The delta's geometry slots: pre-order walk, `has_geometry &&
/// geometry_animated`, deduped (a shared prototype subtree can repeat a
/// path). The pose frame ships the slots in this order and the node table
/// marks which nodes they belong to, so a reader re-derives the walk instead
/// of being handed a second list.
fn animated_geometry_paths(nodes: &[RenderNode]) -> Vec<String> {
    fn walk<'a>(nodes: &'a [RenderNode], paths: &mut Vec<String>, seen: &mut HashSet<&'a str>) {
        for node in nodes {
            // The seen set borrows the paths, so the list holds the only
            // owned copy: one clone per emitted slot.
            if node.has_geometry && node.geometry_animated && seen.insert(node.path.as_str()) {
                paths.push(node.path.clone());
            }
            walk(&node.children, paths, seen);
        }
    }
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    walk(nodes, &mut paths, &mut seen);
    paths
}

/// Pose node record flags. The frontend decoder
/// (src/lib/render/poseDecoder.ts) mirrors these.
const POSE_LEAF: u32 = u32::MAX;
const POSE_NO_MATERIAL: u32 = u32::MAX;
const POSE_FLAG_HAS_GEOMETRY: u8 = 1 << 0;
const POSE_FLAG_GEOMETRY_ANIMATED: u8 = 1 << 1;
const POSE_FLAG_INSTANCES: u8 = 1 << 2;
const POSE_FLAG_IS_POINTS: u8 = 1 << 3;
/// The node carries any motion signal. It is not redundant with
/// `geometry_animated`: the pose path gates its whole drawable update — the
/// instance count and matrices included — on it.
const POSE_FLAG_ANIMATED: u8 = 1 << 4;

/// Pre-order flatten of the delta tree: a node's children sit directly after
/// it, so `first_child_id` is always `index + 1` when it has any.
fn flatten_pose<'a>(nodes: &'a [RenderNode], flat: &mut Vec<&'a RenderNode>) {
    for node in nodes {
        flat.push(node);
        flatten_pose(&node.children, flat);
    }
}

/// `[u32 path id][u32 first child id][u16 child count][u8 flags][u8 visible]
/// [u32 material id][16 x f32 matrix]`, then, when the node owns instances,
/// `[u32 count][count x 16 f32]`. Matrices go out as f32: display transforms
/// tolerate the precision, and the matrix halves its per-node bytes.
fn write_pose_node(
    out: &mut Vec<u8>,
    node: &RenderNode,
    path_id: u32,
    material_id: u32,
    index: usize,
) -> Result<(), String> {
    let child_count = u16::try_from(node.children.len())
        .map_err(|_| format!("pose node {} has too many children", node.path))?;
    let mut flags = 0u8;
    if node.has_geometry {
        flags |= POSE_FLAG_HAS_GEOMETRY;
    }
    if node.geometry_animated {
        flags |= POSE_FLAG_GEOMETRY_ANIMATED;
    }
    if !node.instances.is_empty() {
        flags |= POSE_FLAG_INSTANCES;
    }
    if node.type_name == "Points" {
        flags |= POSE_FLAG_IS_POINTS;
    }
    if node.animated {
        flags |= POSE_FLAG_ANIMATED;
    }
    let first_child = if node.children.is_empty() {
        POSE_LEAF
    } else {
        index as u32 + 1
    };
    out.extend(path_id.to_le_bytes());
    out.extend(first_child.to_le_bytes());
    out.extend(child_count.to_le_bytes());
    out.extend([flags, u8::from(node.visible)]);
    out.extend(material_id.to_le_bytes());
    for value in node.transform {
        out.extend((value as f32).to_le_bytes());
    }
    if !node.instances.is_empty() {
        out.extend((node.instances.len() as u32).to_le_bytes());
        for instance in &node.instances {
            for value in instance {
                out.extend((*value as f32).to_le_bytes());
            }
        }
    }
    Ok(())
}

/// The merged pose response, one invoke per pose:
/// `[u32 LE path count][per path: u32 LE length + utf8 bytes][4-byte pad]
/// [u32 LE material count][per material: u32 LE length + utf8 bytes][4-byte
/// pad][u32 LE node count][pre-order node records][geometry batch payload]`.
/// Prefixes carry the true byte lengths and the padding is implicit
/// (`align4`), so the batch tail — and every slot inside it — starts 4-byte
/// aligned and the frontend can view it in place. The node table is the
/// delta tree with paths and material bindings deduplicated into their
/// tables, so a playback step ships no JSON and no repeated strings.
/// shortcut: the merged pose batches ALL geometry_animated prims with no slot cap (the old 32-slice batching is gone), upgrade to a capped batch + per-prim fallback when a stage with more than ~32 deforming prims appears.
fn frame_pose(
    nodes: &[RenderNode],
    slots: &[Result<Arc<[u8]>, String>],
) -> Result<Vec<u8>, String> {
    let mut flat = Vec::with_capacity(nodes.len());
    flatten_pose(nodes, &mut flat);
    let mut ids: HashMap<&str, u32> = HashMap::with_capacity(flat.len());
    let mut table: Vec<&str> = Vec::with_capacity(flat.len());
    for node in &flat {
        if !ids.contains_key(node.path.as_str()) {
            ids.insert(node.path.as_str(), table.len() as u32);
            table.push(node.path.as_str());
        }
    }
    // Only the bindings this frame's nodes actually carry reach the table: a
    // delta ships the handful of prims it touches, not the stage's materials.
    let mut binding_ids: HashMap<&str, u32> = HashMap::new();
    let mut bindings: Vec<&str> = Vec::new();
    for node in &flat {
        if let Some(binding) = node.material.as_deref() {
            if !binding_ids.contains_key(binding) {
                binding_ids.insert(binding, bindings.len() as u32);
                bindings.push(binding);
            }
        }
    }
    let table_len: usize = table.iter().map(|path| 4 + path.len()).sum();
    let align4 = |length: usize| (length + 3) & !3;
    let binding_bytes: usize = bindings
        .iter()
        .map(|binding| align4(4 + binding.len()))
        .sum();
    let payload: usize = slots
        .iter()
        .map(|slot| match slot {
            Ok(bytes) => align4(bytes.len()),
            Err(error) => align4(error.len()),
        })
        .sum();
    let mut out = Vec::with_capacity(
        12 + table_len + binding_bytes + flat.len() * 80 + payload + slots.len() * 8,
    );
    out.extend((table.len() as u32).to_le_bytes());
    for path in &table {
        out.extend((path.len() as u32).to_le_bytes());
        out.extend(path.as_bytes());
    }
    pad_to_4(&mut out);
    out.extend((bindings.len() as u32).to_le_bytes());
    for binding in &bindings {
        out.extend((binding.len() as u32).to_le_bytes());
        out.extend(binding.as_bytes());
        pad_to_4(&mut out);
    }
    out.extend((flat.len() as u32).to_le_bytes());
    for (index, node) in flat.iter().enumerate() {
        let material_id = node
            .material
            .as_deref()
            .map_or(POSE_NO_MATERIAL, |binding| binding_ids[binding]);
        write_pose_node(&mut out, node, ids[node.path.as_str()], material_id, index)?;
    }
    write_batch(&mut out, slots);
    Ok(out)
}

/// A batch pose response: `[u32 LE frame count][frame_count x frame_pose
/// layout]`. Every `frame_pose` ends with its (padded) geometry batch, so each
/// frame is a multiple of 4 bytes long and the next one stays 4-byte aligned.
fn frame_poses(frames: Vec<Vec<u8>>) -> Vec<u8> {
    let frames_len: usize = frames.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(4 + frames_len);
    out.extend((frames.len() as u32).to_le_bytes());
    for mut frame in frames {
        out.append(&mut frame);
    }
    out
}

/// The material data one prim reads (GetMaterial and GetMaterialBatch):
/// synthetic prototype children resolve their material through the real
/// prototype prim (memoized per stage-open like the geometry arms).
fn resolved_material_info(
    stage: &Stage,
    memo: &mut ResolveMemo,
    path: &str,
) -> Result<MaterialInfo, String> {
    let resolved = resolved_render_path(stage, memo, path)?.to_string();
    material_info(stage, &resolved)
}

/// Packed geometry bytes for one prim, tessellating on demand and caching the
/// result (keyed by the resolved path, so prototype children share one
/// tessellation with the prototype prim). Missing prims and non-geometry
/// prims (those outside `renders_geometry`) as well
/// are readable per-call errors; a failed prim never poisons the cache.
fn geometry_bytes(
    stage: &Stage,
    cache: &mut MeshCache,
    memo: &mut ResolveMemo,
    path: &str,
    time: Option<f64>,
) -> Result<Arc<[u8]>, String> {
    let prim_path = resolved_render_path(stage, memo, path)?;
    if let Some(packed) = cache.get(prim_path.as_str(), time) {
        return Ok(packed);
    }
    let key = prim_path.to_string();
    let prim = stage
        .prim(prim_path)
        .map_err(|e| format!("invalid prim path '{}': {}", path, e))?;
    if !prim.is_valid().map_err(stage_err)? {
        return Err(format!("prim not found: {}", path));
    }
    match tessellate_prim(&prim, time)? {
        Some(mesh) => {
            let packed: Arc<[u8]> = pack_geometry(&mesh).into();
            cache.insert(key, time, packed.clone());
            Ok(packed)
        }
        None => Err(format!("no geometry at {}", path)),
    }
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn get_stage_tree(
    stage_id: u64,
    state: tauri::State<'_, StageState>,
) -> Result<Vec<PrimNode>, String> {
    request_stage_tree(&state.sender(stage_id)?)
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
    stage_id: u64,
    path: String,
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<PrimDetails, String> {
    request_stage_details(&state.sender(stage_id)?, &path, time)
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
    stage_id: u64,
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<Vec<RenderNode>, String> {
    request_scene_manifest(&state.sender(stage_id)?, time)
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

// Owner-thread entry for the delta manifest. Kept as the two-command
// reference the pose-equivalence test and the profile probes drive; playback
// itself merged into `get_animated_pose`, so no IPC command wraps this.
pub fn request_animated_manifest(
    sender: &mpsc::Sender<StageRequest>,
    time: Option<f64>,
) -> Result<Vec<RenderNode>, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetAnimatedManifest { time, reply })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn get_time_codes(
    stage_id: u64,
    state: tauri::State<'_, StageState>,
) -> Result<Vec<f64>, String> {
    request_time_codes(&state.sender(stage_id)?)
}

pub fn request_time_codes(sender: &mpsc::Sender<StageRequest>) -> Result<Vec<f64>, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetTimeCodes { reply })
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
    stage_id: u64,
    path: String,
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<tauri::ipc::Response, String> {
    request_geometry_data(&state.sender(stage_id)?, &path, time).map(tauri::ipc::Response::new)
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

// Batched geometry (Phase 2.5 Task 3): one channel round trip for many
// paths (the batch itself is bounded by the caller, at 32-64 in the
// frontend); per-slot fail-soft, response framed by `frame_batch` over the
// raw `tauri::ipc::Response` like the per-path bytes. The per-path command
// is retained for step refetches/previews.
#[tauri::command]
pub async fn get_geometry_batch(
    stage_id: u64,
    paths: Vec<String>,
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<tauri::ipc::Response, String> {
    request_geometry_batch(&state.sender(stage_id)?, &paths, time).map(tauri::ipc::Response::new)
}

pub fn request_geometry_batch(
    sender: &mpsc::Sender<StageRequest>,
    paths: &[String],
    time: Option<f64>,
) -> Result<Vec<u8>, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetGeometryBatch {
            paths: paths.to_vec(),
            time,
            reply,
        })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// One invoke per playback pose: the delta manifest JSON plus the ordered
// `geometry_animated` path list and its geometry batch, framed by `frame_pose`
// into one raw response. Loads / structure rebuilds / `refreshAfterEdit` keep
// the two commands above.
#[tauri::command]
pub async fn get_animated_pose(
    stage_id: u64,
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<tauri::ipc::Response, String> {
    request_animated_pose(&state.sender(stage_id)?, time).map(tauri::ipc::Response::new)
}

pub fn request_animated_pose(
    sender: &mpsc::Sender<StageRequest>,
    time: Option<f64>,
) -> Result<Vec<u8>, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetAnimatedPose { time, reply })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Playback prefetch: K poses in one invoke instead of K invokes, each pose still
// its own owner turn (the owner serializes anyway) and each frame the exact
// bytes `get_animated_pose` returns for that time. Times outside the stage's
// authored code range are dropped rather than fetched (a pre-roll/loop-wrap
// time has no authored pose), so the frame count is the number of frames
// actually returned. Duplicate times are kept: deduping is the caller's call.
#[tauri::command]
pub async fn get_animated_pose_batch(
    stage_id: u64,
    times: Vec<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<tauri::ipc::Response, String> {
    request_animated_pose_batch(&state.sender(stage_id)?, &times).map(tauri::ipc::Response::new)
}

pub fn request_animated_pose_batch(
    sender: &mpsc::Sender<StageRequest>,
    times: &[f64],
) -> Result<Vec<u8>, String> {
    if times.is_empty() {
        return Ok(frame_poses(Vec::new()));
    }
    // The authored codes are the same list the frontend prefetches from; a
    // stage with no sampled attribute has no range, so every time is kept.
    let codes = request_time_codes(sender)?;
    let (first, last) = match (codes.first(), codes.last()) {
        (Some(first), Some(last)) => (*first, *last),
        _ => (f64::NEG_INFINITY, f64::INFINITY),
    };
    let mut frames = Vec::with_capacity(times.len());
    for &time in times {
        if (first..=last).contains(&time) {
            frames.push(request_animated_pose(sender, Some(time))?);
        }
    }
    Ok(frame_poses(frames))
}

// Material binding data for one prim (Task 3): the prim may be the mesh
// (its `material:binding` is resolved inside) or the material itself.
#[tauri::command]
pub async fn get_material_data(
    stage_id: u64,
    path: String,
    state: tauri::State<'_, StageState>,
) -> Result<MaterialInfo, String> {
    request_material_data(&state.sender(stage_id)?, &path)
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

// Batched material (Phase 2 Task 3): one channel round trip for many paths,
// per-slot fail-soft, framed by `frame_batch` over the raw
// `tauri::ipc::Response` like the geometry batch. Slots hold MaterialInfo
// JSON rather than a USDB frame, so the frontend decodes each slot with
// JSON.parse. The per-path command stays for single-prim refetches.
#[tauri::command]
pub async fn get_material_batch(
    stage_id: u64,
    paths: Vec<String>,
    state: tauri::State<'_, StageState>,
) -> Result<tauri::ipc::Response, String> {
    request_material_batch(&state.sender(stage_id)?, &paths).map(tauri::ipc::Response::new)
}

pub fn request_material_batch(
    sender: &mpsc::Sender<StageRequest>,
    paths: &[String],
) -> Result<Vec<u8>, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetMaterialBatch {
            paths: paths.to_vec(),
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
pub async fn set_attribute_value(
    stage_id: u64,
    path: String,
    name: String,
    value: ValuePayload,
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_set_attribute_value(&state.sender(stage_id)?, &path, &name, &value, time)
}

pub fn request_set_attribute_value(
    sender: &mpsc::Sender<StageRequest>,
    path: &str,
    name: &str,
    value: &ValuePayload,
    time: Option<f64>,
) -> Result<(), String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::SetValue {
            path: path.to_string(),
            name: name.to_string(),
            value: value.clone(),
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
pub async fn set_prim_metadata(
    stage_id: u64,
    path: String,
    key: String,
    value: ValuePayload,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_set_prim_metadata(&state.sender(stage_id)?, &path, &key, &value)
}

pub fn request_set_prim_metadata(
    sender: &mpsc::Sender<StageRequest>,
    path: &str,
    key: &str,
    value: &ValuePayload,
) -> Result<(), String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::SetMetadata {
            path: path.to_string(),
            key: key.to_string(),
            value: value.clone(),
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
pub async fn set_variant_selection(
    stage_id: u64,
    path: String,
    variant_set: String,
    selection: Option<String>,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_set_variant_selection(
        &state.sender(stage_id)?,
        &path,
        &variant_set,
        selection.as_deref(),
    )
}

pub fn request_set_variant_selection(
    sender: &mpsc::Sender<StageRequest>,
    path: &str,
    variant_set: &str,
    selection: Option<&str>,
) -> Result<(), String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::SetVariantSelection {
            path: path.to_string(),
            variant_set: variant_set.to_string(),
            selection: selection.map(str::to_string),
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
pub async fn set_prim_texture(
    stage_id: u64,
    path: String,
    texture_path: Option<String>,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_set_prim_texture(&state.sender(stage_id)?, &path, texture_path.as_deref())
}

pub fn request_set_prim_texture(
    sender: &mpsc::Sender<StageRequest>,
    path: &str,
    texture_path: Option<&str>,
) -> Result<(), String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::SetPrimTexture {
            path: path.to_string(),
            texture: texture_path.map(str::to_string),
            reply,
        })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
// Every open spawns a FRESH owner thread and mints the next stage id.
#[tauri::command]
pub async fn open_usd_path(
    path: String,
    state: tauri::State<'_, StageState>,
) -> Result<StageInfo, String> {
    state.open(&PathBuf::from(path), false, None, None)
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn close_stage(stage_id: u64, state: tauri::State<'_, StageState>) -> Result<(), String> {
    state.close_stage(stage_id)
}

#[tauri::command]
pub async fn list_stages(state: tauri::State<'_, StageState>) -> Result<Vec<StageSummary>, String> {
    state.list_stages()
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn get_edit_target(
    stage_id: u64,
    state: tauri::State<'_, StageState>,
) -> Result<EditTargetInfo, String> {
    request_edit_target(&state.sender(stage_id)?)
}

pub fn request_edit_target(sender: &mpsc::Sender<StageRequest>) -> Result<EditTargetInfo, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetEditTarget { reply })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn set_edit_target(
    stage_id: u64,
    identifier: Option<String>,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_set_edit_target(&state.sender(stage_id)?, identifier.as_deref())
}

pub fn request_set_edit_target(
    sender: &mpsc::Sender<StageRequest>,
    identifier: Option<&str>,
) -> Result<(), String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::SetEditTarget {
            identifier: identifier.map(str::to_string),
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
pub async fn list_dirty_layers(
    stage_id: u64,
    state: tauri::State<'_, StageState>,
) -> Result<Vec<LayerInfo>, String> {
    request_list_dirty_layers(&state.sender(stage_id)?)
}

pub fn request_list_dirty_layers(
    sender: &mpsc::Sender<StageRequest>,
) -> Result<Vec<LayerInfo>, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::ListDirtyLayers { reply })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn save_layers(
    stage_id: u64,
    requests: Vec<LayerSaveRequest>,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_save_layers(&state.sender(stage_id)?, &requests)
}

pub fn request_save_layers(
    sender: &mpsc::Sender<StageRequest>,
    requests: &[LayerSaveRequest],
) -> Result<(), String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::SaveLayers {
            requests: requests.to_vec(),
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
pub async fn save_stage_as_usdz(
    stage_id: u64,
    path: String,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_save_stage_as_usdz(&state.sender(stage_id)?, &path)
}

/// Save As usdz: repack the composed stage into a NEW `.usdz` archive. The
/// owner arm composes (session edits included) and writes a fresh package;
/// the original archive and the open stage are untouched.
pub fn request_save_stage_as_usdz(
    sender: &mpsc::Sender<StageRequest>,
    path: &str,
) -> Result<(), String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::SaveStageAsUsdz {
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
pub async fn undo_stage_edit(
    stage_id: u64,
    state: tauri::State<'_, StageState>,
) -> Result<bool, String> {
    request_undo(&state.sender(stage_id)?)
}

/// Revert the most recent mutation. `Ok(false)` = nothing to undo.
pub fn request_undo(sender: &mpsc::Sender<StageRequest>) -> Result<bool, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::Undo { reply })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn redo_stage_edit(
    stage_id: u64,
    state: tauri::State<'_, StageState>,
) -> Result<bool, String> {
    request_redo(&state.sender(stage_id)?)
}

/// Re-apply the newest undone mutation. `Ok(false)` = nothing to redo.
pub fn request_redo(sender: &mpsc::Sender<StageRequest>) -> Result<bool, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::Redo { reply })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn get_undo_state(
    stage_id: u64,
    state: tauri::State<'_, StageState>,
) -> Result<UndoState, String> {
    request_undo_state(&state.sender(stage_id)?)
}

/// Whether an undo/redo is available (`UndoState { can_undo, can_redo }`).
pub fn request_undo_state(sender: &mpsc::Sender<StageRequest>) -> Result<UndoState, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::GetUndoState { reply })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

// Async command so Tauri runs it off the main thread; the body stays
// synchronous and blocks its runtime worker until the stage owner replies.
#[tauri::command]
pub async fn export_layer_text(
    stage_id: u64,
    identifier: String,
    state: tauri::State<'_, StageState>,
) -> Result<String, String> {
    request_export_layer_text(&state.sender(stage_id)?, &identifier)
}

/// The usda text of one stage layer (a pure read — never a file write).
pub fn request_export_layer_text(
    sender: &mpsc::Sender<StageRequest>,
    identifier: &str,
) -> Result<String, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::ExportLayerText {
            identifier: identifier.to_string(),
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
pub async fn import_layer_text(
    stage_id: u64,
    identifier: String,
    text: String,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_import_layer_text(&state.sender(stage_id)?, &identifier, &text)
}

/// Replace a stage layer's in-memory content with parsed usda text. A
/// malformed text leaves the stage untouched; a valid one never writes the
/// layer's file (saving stays the only disk-writing flow).
pub fn request_import_layer_text(
    sender: &mpsc::Sender<StageRequest>,
    identifier: &str,
    text: &str,
) -> Result<(), String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::ImportLayerText {
            identifier: identifier.to_string(),
            text: text.to_string(),
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
pub async fn list_stage_layers(
    stage_id: u64,
    state: tauri::State<'_, StageState>,
) -> Result<Vec<LayerInfo>, String> {
    request_list_stage_layers(&state.sender(stage_id)?)
}

/// Every layer of the stage (session, root, sublayers), dirty or not.
pub fn request_list_stage_layers(
    sender: &mpsc::Sender<StageRequest>,
) -> Result<Vec<LayerInfo>, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::ListStageLayers { reply })
        .map_err(|_| "stage service unavailable".to_string())?;
    response
        .recv()
        .map_err(|_| "stage service unavailable".to_string())?
}

#[cfg(test)]
mod edit_emission_tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name)
    }

    // A write landing inside a native-instance prototype subtree must
    // announce "/" (full scene rebuild): the instances render under
    // rebased paths, so a targeted in-place refresh at the prototype
    // path would find nothing to update and they would stay stale.
    #[test]
    fn prototype_subtree_edits_announce_the_root_path() {
        let (stage, _) = open_stage(&fixture("instanced.usda")).expect("stage should open");
        assert_eq!(edit_emission_path(&stage, "/__Prototype_0"), "/");
        assert_eq!(edit_emission_path(&stage, "/__Prototype_0/Wheel"), "/");
        // Everything outside the prototype namespace keeps its own path:
        // instance prims and proxies (whose writes other guards refuse)
        // and plain prims alike.
        assert_eq!(edit_emission_path(&stage, "/Scene"), "/Scene");
        assert_eq!(
            edit_emission_path(&stage, "/Scene/WheelA/Wheel"),
            "/Scene/WheelA/Wheel"
        );
    }
}

#[cfg(test)]
mod keyed_cache_tests {
    use super::KeyedCache;

    fn key(name: &str) -> String {
        name.to_string()
    }

    // Synthetic per-entry charges: the byte budget, not the entry ceiling,
    // must drive eviction, and the newest insert must survive even alone
    // over budget.
    #[test]
    fn byte_budget_evicts_oldest_and_keeps_newest() {
        let mut cache = KeyedCache::with_limits(1000, 100);
        for name in ["a", "b", "c"] {
            cache.insert(key(name), None, name.to_string(), 400);
        }
        assert!(cache.get("a", None).is_none(), "oldest evicted by bytes");
        assert_eq!(cache.len(), 2, "far below the 100-entry ceiling");
        assert_eq!(cache.bytes, 800);
        // Eviction trimmed the oldest entries only, never cleared the cache.
        assert_eq!(cache.get("b", None), Some(&"b".to_string()));
        assert_eq!(cache.get("c", None), Some(&"c".to_string()));

        cache.insert(key("huge"), None, "huge".to_string(), 4096);
        assert_eq!(cache.get("huge", None), Some(&"huge".to_string()));
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.bytes, 4096);

        cache.clear();
        assert_eq!(cache.bytes, 0);
        assert!(cache.is_empty());
    }
}

#[cfg(test)]
mod pose_frame_tests {
    use super::*;

    fn identity() -> [f64; 16] {
        let mut matrix = [0.0; 16];
        for (index, value) in matrix.iter_mut().enumerate() {
            *value = if index % 5 == 0 { 1.0 } else { 0.0 };
        }
        matrix
    }

    fn node(path: &str, children: Vec<RenderNode>) -> RenderNode {
        RenderNode {
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap_or_default().to_string(),
            type_name: "Mesh".to_string(),
            has_geometry: true,
            animated: true,
            geometry_animated: false,
            material: None,
            instances: Vec::new(),
            transform: identity(),
            visible: true,
            children,
        }
    }

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    fn f32_at(bytes: &[u8], at: usize) -> f32 {
        f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    // An empty delta still frames a readable header: no paths, no materials,
    // no nodes, then the geometry batch envelope with no slots.
    #[test]
    fn frame_pose_emits_an_empty_table_for_an_empty_delta() {
        let frame = frame_pose(&[], &[]).unwrap();
        let mut expected = vec![0u8; 12];
        expected.extend(BATCH_MAGIC.to_le_bytes());
        expected.extend(BATCH_VERSION.to_le_bytes());
        expected.extend(0u32.to_le_bytes());
        assert_eq!(
            frame, expected,
            "empty path + material tables, zero nodes, empty batch"
        );
    }

    // The node record, field by field, at its documented offsets.
    #[test]
    fn frame_pose_pins_the_node_record_bytes() {
        let mut root = node("/A", vec![node("/A/B", Vec::new())]);
        root.transform[0] = 0.1; // not exactly representable in f32
        root.visible = false;
        root.geometry_animated = true;
        root.type_name = "Points".to_string();
        root.material = Some("/Looks/Mat".to_string());
        root.instances = vec![identity()];
        let frame = frame_pose(&[root], &[]).unwrap();

        // Path table: count, then per path a u32 length + utf8.
        let mut at = 0;
        assert_eq!(u32_at(&frame, at), 2, "two unique paths");
        at += 4;
        for path in ["/A", "/A/B"] {
            assert_eq!(u32_at(&frame, at) as usize, path.len());
            at += 4;
            assert_eq!(&frame[at..at + path.len()], path.as_bytes());
            at += path.len();
        }
        at = (at + 3) & !3;

        // Material table: only the distinct bindings the nodes carry, each
        // entry padded to 4 so the node table stays aligned.
        assert_eq!(u32_at(&frame, at), 1, "one distinct binding");
        at += 4;
        assert_eq!(u32_at(&frame, at) as usize, "/Looks/Mat".len());
        assert_eq!(&frame[at + 4..at + 4 + 10], b"/Looks/Mat");
        at = (at + 4 + 10 + 3) & !3;

        assert_eq!(u32_at(&frame, at), 2, "two nodes, pre-order");
        at += 4;

        // Root: path id 0, first child is the next index, one child.
        assert_eq!(u32_at(&frame, at), 0, "root path id");
        assert_eq!(u32_at(&frame, at + 4), 1, "first child id");
        assert_eq!(
            u16::from_le_bytes(frame[at + 8..at + 10].try_into().unwrap()),
            1,
            "child count"
        );
        assert_eq!(
            frame[at + 10],
            POSE_FLAG_HAS_GEOMETRY
                | POSE_FLAG_GEOMETRY_ANIMATED
                | POSE_FLAG_INSTANCES
                | POSE_FLAG_IS_POINTS
                | POSE_FLAG_ANIMATED
        );
        assert_eq!(frame[at + 11], 0, "invisible root");
        assert_eq!(u32_at(&frame, at + 12), 0, "root material id");
        assert_eq!(f32_at(&frame, at + 16), 0.1f32, "matrix element 0 as f32");
        let instances = at + 16 + 64;
        assert_eq!(u32_at(&frame, instances), 1, "one instance matrix");
        assert_eq!(f32_at(&frame, instances + 4), 1.0, "identity element 0");

        // Leaf: path id 1, the leaf sentinel, no children, no material.
        let leaf = instances + 4 + 64;
        assert_eq!(u32_at(&frame, leaf), 1, "leaf path id");
        assert_eq!(u32_at(&frame, leaf + 4), POSE_LEAF, "leaf first child");
        assert_eq!(
            u16::from_le_bytes(frame[leaf + 8..leaf + 10].try_into().unwrap()),
            0,
            "leaf child count"
        );
        assert_eq!(
            frame[leaf + 10],
            POSE_FLAG_HAS_GEOMETRY | POSE_FLAG_ANIMATED,
            "leaf flags"
        );
        assert_eq!(frame[leaf + 11], 1, "visible leaf");
        assert_eq!(u32_at(&frame, leaf + 12), POSE_NO_MATERIAL, "no binding");
        let tail = leaf + 16 + 64;
        assert_eq!(frame.len(), tail + 12, "then the geometry batch envelope");
        assert_eq!(u32_at(&frame, tail), BATCH_MAGIC);
        assert_eq!(u32_at(&frame, tail + 4), BATCH_VERSION);
        assert_eq!(u32_at(&frame, tail + 8), 0, "no geometry slots here");
    }

    // A zero-child root list: as many roots as nodes, none pointing at a child.
    #[test]
    fn frame_pose_marks_every_childless_root_list_entry_as_a_leaf() {
        let roots: Vec<RenderNode> = (0..3)
            .map(|index| node(&format!("/R{index}"), Vec::new()))
            .collect();
        let frame = frame_pose(&roots, &[]).unwrap();
        let table_end = 4 + roots.iter().map(|root| 4 + root.path.len()).sum::<usize>();
        let mut at = (table_end + 3) & !3;
        assert_eq!(u32_at(&frame, at), 0, "no bindings on these roots");
        at += 4;
        assert_eq!(u32_at(&frame, at), 3, "three roots");
        at += 4;
        for index in 0..3 {
            assert_eq!(u32_at(&frame, at), index as u32, "root {index} path id");
            assert_eq!(u32_at(&frame, at + 4), POSE_LEAF, "root {index} is a leaf");
            at += 80;
        }
        assert_eq!(at + 12, frame.len(), "then the geometry batch envelope");
    }

    // Payload budget: a bike pose is ~190 delta nodes with ~30-byte paths, ~31
    // distinct material bindings and no geometry slots. 200 nodes x 80 B +
    // ~200 x 34 B of path table + 31 x ~44 B of material table = ~24 KB. The
    // JSON it replaces measured ~78 KB. (The plan's "16 KB" predates the
    // 16-byte node header + 64-byte matrix arithmetic: 200 nodes alone are
    // 15.2 KB, which leaves no room for paths or bindings.)
    #[test]
    fn frame_pose_keeps_a_realistic_pose_within_the_payload_budget() {
        let children: Vec<RenderNode> = (0..199)
            .map(|index| {
                let mut child = node(
                    &format!("/Hummingbird/Wing_L/Feather.{index:03}"),
                    Vec::new(),
                );
                child.material = Some(format!("/Hummingbird/Looks/Body_{:02}", index % 31));
                child
            })
            .collect();
        let root = node("/Hummingbird", children);
        let frame = frame_pose(&[root], &[]).unwrap();
        assert!(
            frame.len() < 28 * 1024,
            "200-node pose frame is {} B, over the ~24 KB budget",
            frame.len()
        );
        println!("200-node pose frame: {} B", frame.len());
    }
}

#[cfg(test)]
mod pose_frame_cache_tests {
    use super::PoseFrameCache;
    use std::sync::Arc;

    fn frame(byte: u8) -> Arc<[u8]> {
        Arc::from(vec![byte; 4])
    }

    // The frame cache is byte-bounded like the MeshCache: over budget it
    // evicts the oldest assembled frame, and a hit returns the same bytes.
    #[test]
    fn byte_budget_evicts_the_oldest_frame_and_a_hit_returns_it() {
        let mut cache = PoseFrameCache::with_limits(12, 8);
        cache.insert(Some(1.0), frame(1));
        cache.insert(Some(2.0), frame(2));
        cache.insert(Some(3.0), frame(3));
        assert_eq!(cache.len(), 3, "three 4-byte frames fit 12 bytes");
        assert_eq!(cache.get(Some(2.0)).as_deref(), Some(&[2u8; 4][..]));

        cache.insert(Some(4.0), frame(4));
        assert_eq!(cache.len(), 3, "the newest frame made room for itself");
        assert!(
            cache.get(Some(1.0)).is_none(),
            "the oldest frame went first"
        );
        assert!(cache.get(Some(4.0)).is_some());

        cache.clear();
        assert_eq!(cache.len(), 0);
        assert!(cache.get(Some(4.0)).is_none());
    }
}
