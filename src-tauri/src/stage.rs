use std::any::Any;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use openusd::ar::DefaultResolver;
use openusd::gf;
use openusd::sdf::{self, ValueTypeName};
use openusd::usd::{
    ApplyMode, Diff, EditTarget, EditTargetArc, InitialLoadSet, PrimPredicate, ReplayStage,
    SchemaBase, Stage, StageAuthoringError, TimeCode, UndoStage,
};
use openusd_schemas::geom::{
    Imageable, ImageableExt, PointInstancer, PointInstancerSchema, Purpose, Visibility,
};
use openusd_schemas::shade::{Material, MaterialBindingAPI};
use serde::{Deserialize, Serialize};

use crate::fetcher::get_usdbee_cache_dir;
use crate::materials::{material_info, MaterialInfo};
use crate::tessellation::{pack_geometry, tessellate_prim, MeshData};
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
    // One channel round trip for many geometry fetches (Phase 2.5 Task 3):
    // per-slot fail-soft (a bad path becomes an error slot), framed by
    // `frame_batch` so the whole batch either arrives complete or errors.
    GetGeometryBatch {
        paths: Vec<String>,
        time: Option<f64>,
        reply: mpsc::Sender<Result<Vec<u8>, String>>,
    },
    GetMaterial {
        path: String,
        reply: mpsc::Sender<Result<MaterialInfo, String>>,
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
        LayerLedger { entries: Vec::new() }
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

pub struct StageState {
    pub sender: mpsc::Sender<StageRequest>,
    // Tessellations the owner's MeshCache filled since the last Open. Shared
    // handle so tests (and any introspection) can count real tessellation
    // work without reaching into the owner thread; used by the dedup pin.
    tessellations: Arc<AtomicUsize>,
}

impl StageState {
    pub fn mesh_tessellations(&self) -> usize {
        self.tessellations.load(Ordering::Relaxed)
    }
}

/// Actor-side `usd-stage-changed` emitter: called with the edited prim
/// paths after each successful mutation. lib.rs bridges it to the Tauri
/// event (payload `{ "paths": [...] }`); tests capture it in a channel.
pub type StageChangeSink = Box<dyn Fn(&[String]) + Send>;

pub fn spawn_stage_owner() -> StageState {
    spawn_stage_owner_with_sink(None)
}

pub fn spawn_stage_owner_with_sink(sink: Option<StageChangeSink>) -> StageState {
    let (sender, receiver) = mpsc::channel();
    let tessellations = Arc::new(AtomicUsize::new(0));
    let owner_counter = tessellations.clone();
    thread::spawn(move || {
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
        // The time-independent manifest skeleton, built by the first manifest
        // call after an open; cleared on Open (like the geometry MeshCache).
        let mut manifest_skeleton: Option<ManifestSkeleton> = None;
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
        // Requested-render-path -> geometry-cache-key resolutions, shared by
        // the geometry/material arms; cleared on Open. Prototype resolution
        // measured 0.4 ms/call (Task 1 profile c): memoizing turns repeats
        // and batch dups into map lookups.
        let mut resolve_memo = ResolveMemo::new();
        while let Ok(request) = receiver.recv() {
            match request {
                StageRequest::Open {
                    path,
                    is_usdz,
                    reply,
                } => {
                    let response = catch_unwind(AssertUnwindSafe(|| {
                        let (stage, info) = open_stage(&path)?;
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
                    stage_is_usdz = response.is_ok()
                        && (is_usdz
                            || path
                                .extension()
                                .and_then(|extension| extension.to_str())
                                .is_some_and(|extension| extension.eq_ignore_ascii_case("usdz")));
                    mesh_cache.clear();
                    manifest_skeleton = None;
                    resolve_memo.clear();
                    dirty_ledger.clear();
                    undo_journal.clear();
                    redo_stack.clear();
                    owner_counter.store(0, Ordering::Relaxed);
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
                            if manifest_skeleton.is_none() {
                                manifest_skeleton = Some(ManifestSkeleton::build(stage)?);
                            }
                            let skeleton = manifest_skeleton
                                .as_ref()
                                .ok_or_else(|| "manifest skeleton build failed".to_string())?;
                            let mut prototype_memo = PrototypeMemo::new();
                            render_children(
                                skeleton,
                                &skeleton.root_children,
                                time,
                                false,
                                &mut prototype_memo,
                            )
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
                StageRequest::GetMaterial { path, reply } => {
                    let response = match current_stage {
                        Some(ref stage) => catch_unwind(AssertUnwindSafe(|| {
                            // Synthetic prototype children resolve their
                            // material through the real prototype prim
                            // (memoized per stage-open like the geometry
                            // arms).
                            let resolved =
                                resolved_render_path(stage, &mut resolve_memo, &path)?.to_string();
                            material_info(stage, &resolved)
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
                            record_user_mutation(
                                replay,
                                &mut undo_journal,
                                &mut redo_stack,
                                &mut dirty_ledger,
                                stage.edit_target().layer_identifier(),
                                &path,
                            );
                            after_mutation(
                                &sink,
                                &mut mesh_cache,
                                &mut manifest_skeleton,
                                &mut resolve_memo,
                                &path,
                            );
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
                            );
                            after_mutation(
                                &sink,
                                &mut mesh_cache,
                                &mut manifest_skeleton,
                                &mut resolve_memo,
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
                            );
                            after_mutation(
                                &sink,
                                &mut mesh_cache,
                                &mut manifest_skeleton,
                                &mut resolve_memo,
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
                        Some(ref stage) => {
                            catch_unwind(AssertUnwindSafe(|| export_stage_as_usdz(stage, &path)))
                                .unwrap_or_else(panic_reply)
                        }
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
                                redo_stack.push(entry);
                                after_mutation(
                                    &sink,
                                    &mut mesh_cache,
                                    &mut manifest_skeleton,
                                    &mut resolve_memo,
                                    &path,
                                );
                            }
                            None => {
                                // The UndoStage reverted a transaction the
                                // journal does not know (an asymmetric
                                // commit); refresh coarsely rather than
                                // leave stale caches.
                                eprintln!(
                                    "usdbee: undo journal desync — emitting a root refresh"
                                );
                                after_mutation(
                                    &sink,
                                    &mut mesh_cache,
                                    &mut manifest_skeleton,
                                    &mut resolve_memo,
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
                            let entry = redo_stack
                                .pop()
                                .expect("the empty case matched above");
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
                                push_bounded(&mut undo_journal, entry);
                                after_mutation(
                                    &sink,
                                    &mut mesh_cache,
                                    &mut manifest_skeleton,
                                    &mut resolve_memo,
                                    &path,
                                );
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
                        Some(ref stage) => {
                            catch_unwind(AssertUnwindSafe(|| {
                                Ok(UndoState {
                                    can_undo: stage.can_undo(),
                                    can_redo: !redo_stack.is_empty(),
                                })
                            }))
                            .unwrap_or_else(panic_reply)
                        }
                        None => Err("no stage open".to_string()),
                    };
                    let _ = reply.send(response);
                }
                StageRequest::ExportLayerText {
                    identifier,
                    reply,
                } => {
                    // A pure read: no caches clear, no event fires.
                    let response = match current_stage {
                        Some(ref stage) => {
                            catch_unwind(AssertUnwindSafe(|| export_layer_text_impl(stage, &identifier)))
                                .unwrap_or_else(panic_reply)
                        }
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
                        Some(ref stage) => {
                            catch_unwind(AssertUnwindSafe(|| import_layer_text_impl(stage, &identifier, &text)))
                                .unwrap_or_else(panic_reply)
                        }
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
                            );
                            after_mutation(
                                &sink,
                                &mut mesh_cache,
                                &mut manifest_skeleton,
                                &mut resolve_memo,
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
            }
        }
    });
    StageState {
        sender,
        tessellations,
    }
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
    // spellings directly; these arms keep the round trip consistent).
    let spelling = match payload.r#type.as_str() {
        "assetpath" => "asset",
        "vec3f" => "float3",
        "vec3d" => "double3",
        "token_array" => "token[]",
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

/// Post-success bookkeeping every mutation arm shares: the coarse cache
/// clears (tessellations, manifest skeleton, resolve memo) and the
/// `usd-stage-changed` emission for the edited path. The dirty mark and the
/// undo journal live in `record_user_mutation` (mutation arms) or the
/// undo/redo arms' own ledger updates.
fn after_mutation(
    sink: &Option<StageChangeSink>,
    mesh_cache: &mut MeshCache,
    manifest_skeleton: &mut Option<ManifestSkeleton>,
    resolve_memo: &mut ResolveMemo,
    path: &str,
) {
    // shortcut: coarse clear — any edit invalidates every cached
    // tessellation; per-path eviction when edits grow edit-target awareness
    mesh_cache.clear();
    // shortcut: coarse clear — any edit can change composed
    // types/purpose/bindings, so the whole manifest skeleton rebuilds;
    // fine until edits become frequent
    *manifest_skeleton = None;
    resolve_memo.clear();
    if let Some(sink) = sink {
        let edited = path.to_string();
        sink(std::slice::from_ref(&edited));
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
/// successful arm).
fn record_user_mutation(
    replay: &ReplayStage,
    journal: &mut VecDeque<MutationEntry>,
    redo: &mut Vec<MutationEntry>,
    ledger: &mut LayerLedger,
    layer: &str,
    path: &str,
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

/// Every layer of the stage in stack order (session, root, sublayers),
/// dirty or not — the text editor's layer selector. The same walk
/// `dirty_layers_info` filters down to the unsaved ones.
fn stage_layers_info(stage: &Stage) -> Result<Vec<LayerInfo>, String> {
    let session = session_identifier(stage);
    Ok(stage
        .layer_stack()
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
fn import_layer_text_impl(
    stage: &Stage,
    identifier: &str,
    text: &str,
) -> Result<String, String> {
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
            .ok_or_else(|| sdf::DataError::MissingSpec {
                path: path.clone(),
            })?;
        dst.create_spec(path.clone(), spec_type);
        for field in src.list_fields(&path).unwrap_or_default() {
            let value = src.get_field(&path, &field)?;
            dst.set_field(&path, &field, value.into_owned());
        }
    }
    Ok(())
}

/// Lexical same-file comparison for the session-layer refusal: both paths
/// made absolute, then compared component-wise.
/// shortcut: symlinked or `..`-laden aliases of one file can slip through;
/// upgrade to canonicalize-based comparison if a collision ever matters
/// beyond the dialog's own defaults.
fn paths_match(a: &str, b: &str) -> bool {
    let absolute = |path: &str| {
        let path = Path::new(path);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir().unwrap_or_default().join(path)
        }
    };
    absolute(a) == absolute(b)
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
    let stack = stage.layer_stack();
    // Validate every request before writing any file: a batch with one bad
    // request must leave every file and the dirty state untouched (the
    // caller clears dirty ids only on a fully successful save).
    let mut validated = Vec::with_capacity(requests.len());
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
        if Some(request.identifier.as_str()) == session.as_deref() {
            if extension != "usda" {
                return Err(format!(
                    "the session layer {} only saves as a new .usda file",
                    request.identifier
                ));
            }
            if let Some(colliding) = stack.iter().find(|id| paths_match(id, &request.path)) {
                return Err(format!(
                    "refusing to save the session layer over {}; session layers save to a new .usda path",
                    colliding
                ));
            }
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

/// Save As usdz: repack the composed stage into a NEW `.usdz` archive at
/// `path`. `Stage::flatten` composes every opinion (the session layer's
/// edits included) into one anonymous layer, and `Layer::export` writes a
/// `.usdz` as a single crate-encoded entry — so the original archive is
/// never touched and nothing about the open stage changes. Deliberately NOT
/// a layer save: no save_layers rules, no clean markings, no event.
fn export_stage_as_usdz(stage: &Stage, path: &str) -> Result<(), String> {
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
    let flattened = stage
        .flatten()
        .map_err(|e| format!("failed to compose the stage for '{}': {}", path, e))?;
    flattened
        .export(path)
        .map_err(|e| format!("failed to save the stage as '{}': {}", path, e))
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
/// identically for every call at every time. Visibility values, transform
/// evaluation and the PointInstancer instance arrays are NOT here — they
/// sample the requested time and stay per-call.
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
/// built once, held in the stage-owner loop state, cleared on `Open` like
/// the MeshCache. Each manifest call samples ONLY the per-time data
/// (transforms, visibility, instancer arrays) against the cached skeleton.
struct ManifestSkeleton {
    /// Facts for every prim reachable from the pseudo-root plus every
    /// prototype subtree discovered along the way (native prototype roots
    /// live outside the pseudo-root namespace, so a flat map keyed by path
    /// reaches both). Values are keyed by their composed path spelling.
    facts: HashMap<String, SkeletonFacts>,
    root_children: Vec<String>,
}

impl ManifestSkeleton {
    fn build(stage: &Stage) -> Result<ManifestSkeleton, String> {
        let mut skeleton = ManifestSkeleton {
            facts: HashMap::new(),
            root_children: Vec::new(),
        };
        let mut pending: Vec<sdf::Path> = Vec::new();
        let pseudo_root = stage
            .prim(sdf::Path::abs_root())
            .map_err(|e| format!("invalid pseudo-root path: {}", e))?;
        skeleton.root_children = build_facts(stage, &pseudo_root, &mut skeleton, &mut pending)?;
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
            build_facts(stage, &prim, &mut skeleton, &mut pending)?;
        }
        Ok(skeleton)
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

    // Only plain prims recurse into prim children: an instance's prim
    // children are instance proxies (rendered via its prototype expansion,
    // never walked per instance) and a PointInstancer renders synthetic
    // children only. This keeps the build linear in walked prims, mirroring
    // what the per-call walk actually visits.
    let mut children = Vec::new();
    if matches!(kind, SkeletonKind::Plain) {
        for child in visible_children(prim)? {
            let child_key = child.path().to_string();
            build_facts(stage, &child, skeleton, pending)?;
            children.push(child_key);
        }
    }

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
    let (self_moves, self_deforms) = samples_scene_motion(prim, renders)?;

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
    skeleton: &ManifestSkeleton,
    prim: &openusd::usd::Prim,
    prototypes: &[sdf::Path],
    time: Option<f64>,
    instancer_moves: bool,
    prototype_memo: &mut PrototypeMemo,
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
        // cached fact; visibility samples the requested time.
        let (excluded, visible) = if prototype.excluded {
            (true, true)
        } else {
            (false, visibility_at(prototype, time)?)
        };
        let type_name = prototype.type_name.clone();
        let proto_xform = local_transform(&prototype.prim, time)?.unwrap_or(gf::Matrix4d::IDENTITY);
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
        let mut prototype_children = render_children(
            skeleton,
            &prototype.children,
            time,
            animated,
            prototype_memo,
        )?;
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
/// (prototype path, ancestor-moves): identical compositions share one
/// prototype, so the tree is walked once and cloned per instance. The
/// ancestor-moves variant of the animated flag keeps the two states apart.
type PrototypeMemo = HashMap<(sdf::Path, bool), Vec<RenderNode>>;

fn native_prototype_children(
    skeleton: &ManifestSkeleton,
    instance: &openusd::usd::Prim,
    prototype: Option<&sdf::Path>,
    time: Option<f64>,
    ancestor_moves: bool,
    prototype_memo: &mut PrototypeMemo,
) -> Result<Vec<RenderNode>, String> {
    let Some(prototype_path) = prototype else {
        return Ok(Vec::new());
    };
    // The prototype subtree is identical for every instance sharing one
    // prototype (pcp mints the prototype exactly when compositions agree),
    // so its rendered tree is walked once per (prototype, ancestor-moves)
    // and cloned per instance — only the path rebase differs. The memo is
    // per-call state: its entries hold sampled transforms and visibility,
    // so they must not outlive the manifest call that built them.
    let memo_key = (prototype_path.clone(), ancestor_moves);
    let mut raw = match prototype_memo.get(&memo_key) {
        Some(children) => children.clone(),
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
            let children =
                render_children(skeleton, &prototype.children, time, moves, prototype_memo)?;
            prototype_memo.insert(memo_key.clone(), children.clone());
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
    prototype_memo: &mut PrototypeMemo,
) -> Result<Vec<RenderNode>, String> {
    match &facts.kind {
        SkeletonKind::PointInstancer { prototypes } => prototype_children(
            skeleton,
            &facts.prim,
            prototypes,
            time,
            ancestor_moves,
            prototype_memo,
        ),
        SkeletonKind::NativeInstance { prototype } => native_prototype_children(
            skeleton,
            &facts.prim,
            prototype.as_ref(),
            time,
            ancestor_moves,
            prototype_memo,
        ),
        SkeletonKind::Plain => render_children(
            skeleton,
            &facts.children,
            time,
            ancestor_moves,
            prototype_memo,
        ),
    }
}

fn render_children(
    skeleton: &ManifestSkeleton,
    children: &[String],
    time: Option<f64>,
    ancestor_moves: bool,
    prototype_memo: &mut PrototypeMemo,
) -> Result<Vec<RenderNode>, String> {
    let mut nodes = Vec::new();
    for child in children {
        let facts = skeleton
            .facts
            .get(child)
            .ok_or_else(|| format!("cached manifest facts missing for prim {}", child))?;
        let deforms = facts.renders_geometry && facts.self_deforms;
        let moves = ancestor_moves || facts.self_moves;
        let transform = local_transform(&facts.prim, time)?.unwrap_or(gf::Matrix4d::IDENTITY);
        if facts.excluded {
            // Purpose proxy/guide is a cached fact: the prim itself emits
            // nothing and its descendants flatten up with its transform
            // composed in — but they still need this call's sampling.
            let mut descendants =
                render_node_children(skeleton, facts, time, moves, prototype_memo)?;
            for descendant in &mut descendants {
                descendant.transform = (transform * gf::Matrix4d(descendant.transform)).0;
            }
            nodes.extend(descendants);
            continue;
        }
        // Visibility is time-dependent by USD semantics — computed per call,
        // never cached across manifest calls (Task 1 ruling).
        let visible = visibility_at(facts, time)?;
        let node_children = render_node_children(skeleton, facts, time, moves, prototype_memo)?;
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

/// Computed visibility at the requested time — the one per-time imageable
/// query the walk keeps (Task 1: compute_visibility must stay per-time and
/// is NOT cached; non-imageable prims stay visible, matching the old
/// renderable_state semantics).
fn visibility_at(facts: &SkeletonFacts, time: Option<f64>) -> Result<bool, String> {
    if !facts.imageable {
        return Ok(true);
    }
    let imageable = Imageable::from_prim(facts.prim.clone())
        .map_err(stage_err)?
        .ok_or_else(|| {
            format!(
                "imageable view missing for {} at manifest cache build",
                facts.prim.path()
            )
        })?;
    Ok(imageable
        .compute_visibility(time.map(TimeCode::new))
        .map_err(stage_err)?
        != Visibility::Invisible)
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
    let mut prototype_memo = PrototypeMemo::new();
    render_children(
        &skeleton,
        &skeleton.root_children,
        time,
        false,
        &mut prototype_memo,
    )
}

/// Tessellation cache owned by the stage-owner thread: (prim path, time as
/// queried) -> mesh. `None` and `Some(t)` are distinct keys.
pub struct MeshCache {
    entries: HashMap<(String, Option<u64>), Arc<MeshData>>,
    // Shared with StageState so tessellation-filling work can be counted
    // from outside the owner thread.
    tessellations: Arc<AtomicUsize>,
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
    // Kitchen_set_instanced tessellates 1,462 unique prototype meshes per
    // load (pack bytes measured 14.7 MB total); 256 full-cleared twice per
    // pass defeats the warm hit. The cap must hold a full scene.
    const CAP: usize = 2048;

    pub fn new() -> Self {
        Self::with_counter(Arc::new(AtomicUsize::new(0)))
    }

    pub fn with_counter(counter: Arc<AtomicUsize>) -> Self {
        Self {
            entries: HashMap::new(),
            tessellations: counter,
        }
    }

    pub fn get(&self, key: &(String, Option<f64>)) -> Option<Arc<MeshData>> {
        self.entries.get(&cache_key(key.clone())).cloned()
    }

    pub fn insert(&mut self, key: (String, Option<f64>), mesh: Arc<MeshData>) {
        // shortcut: primitive eviction — a full clear at the cap; measured rule: cap
        // 2048 holds both benchmark heaps (kitchen 1,462 keys / 14.7 MB packed),
        // raise further only if a scene exceeds it
        if !self.entries.contains_key(&cache_key(key.clone())) && self.entries.len() >= Self::CAP {
            self.entries.clear();
        }
        self.tessellations.fetch_add(1, Ordering::Relaxed);
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

fn frame_batch(slots: Vec<Result<Vec<u8>, String>>) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + slots.len() * 4);
    out.extend(BATCH_MAGIC.to_le_bytes());
    out.extend(BATCH_VERSION.to_le_bytes());
    out.extend((slots.len() as u32).to_le_bytes());
    for slot in slots {
        match slot {
            Ok(bytes) => {
                out.extend(0u32.to_le_bytes());
                out.extend((bytes.len() as u32).to_le_bytes());
                out.extend(bytes);
            }
            Err(error) => {
                out.extend(1u32.to_le_bytes());
                out.extend((error.len() as u32).to_le_bytes());
                out.extend(error.into_bytes());
            }
        }
        // USDB frames are already a multiple of 4 (u32 header + f32/u32
        // data), but error messages are arbitrary UTF-8; zero-pad so slot
        // boundaries never depend on payload alignment.
        let pad = (4 - out.len() % 4) % 4;
        out.extend(std::iter::repeat_n(0u8, pad));
    }
    out
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
) -> Result<Vec<u8>, String> {
    let prim_path = resolved_render_path(stage, memo, path)?;
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

// Batched geometry (Phase 2.5 Task 3): one channel round trip for many
// paths (the batch itself is bounded by the caller, at 32-64 in the
// frontend); per-slot fail-soft, response framed by `frame_batch` over the
// raw `tauri::ipc::Response` like the per-path bytes. The per-path command
// is retained for step refetches/previews.
#[tauri::command]
pub async fn get_geometry_batch(
    paths: Vec<String>,
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<tauri::ipc::Response, String> {
    request_geometry_batch(&state.sender, &paths, time).map(tauri::ipc::Response::new)
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
pub async fn set_attribute_value(
    path: String,
    name: String,
    value: ValuePayload,
    time: Option<f64>,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_set_attribute_value(&state.sender, &path, &name, &value, time)
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
    path: String,
    key: String,
    value: ValuePayload,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_set_prim_metadata(&state.sender, &path, &key, &value)
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
    path: String,
    variant_set: String,
    selection: Option<String>,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_set_variant_selection(&state.sender, &path, &variant_set, selection.as_deref())
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
pub async fn open_usd_path(
    path: String,
    state: tauri::State<'_, StageState>,
) -> Result<StageInfo, String> {
    request_stage_open(&PathBuf::from(path), false, &state.sender)
}

/// `is_usdz` carries the archive origin the dialog flow knows (it opens the
/// extracted cache copy, not the archive); plain callers pass false and rely
/// on the Open arm's suffix derivation for direct `.usdz` opens.
pub fn request_stage_open(
    path: &Path,
    is_usdz: bool,
    sender: &mpsc::Sender<StageRequest>,
) -> Result<StageInfo, String> {
    let (reply, response) = mpsc::channel();
    sender
        .send(StageRequest::Open {
            path: path.to_path_buf(),
            is_usdz,
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
pub async fn get_edit_target(
    state: tauri::State<'_, StageState>,
) -> Result<EditTargetInfo, String> {
    request_edit_target(&state.sender)
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
    identifier: Option<String>,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_set_edit_target(&state.sender, identifier.as_deref())
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
    state: tauri::State<'_, StageState>,
) -> Result<Vec<LayerInfo>, String> {
    request_list_dirty_layers(&state.sender)
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
    requests: Vec<LayerSaveRequest>,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_save_layers(&state.sender, &requests)
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
    path: String,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_save_stage_as_usdz(&state.sender, &path)
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
pub async fn undo_stage_edit(state: tauri::State<'_, StageState>) -> Result<bool, String> {
    request_undo(&state.sender)
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
pub async fn redo_stage_edit(state: tauri::State<'_, StageState>) -> Result<bool, String> {
    request_redo(&state.sender)
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
pub async fn get_undo_state(state: tauri::State<'_, StageState>) -> Result<UndoState, String> {
    request_undo_state(&state.sender)
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
    identifier: String,
    state: tauri::State<'_, StageState>,
) -> Result<String, String> {
    request_export_layer_text(&state.sender, &identifier)
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
    identifier: String,
    text: String,
    state: tauri::State<'_, StageState>,
) -> Result<(), String> {
    request_import_layer_text(&state.sender, &identifier, &text)
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
    state: tauri::State<'_, StageState>,
) -> Result<Vec<LayerInfo>, String> {
    request_list_stage_layers(&state.sender)
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
