// Shared scaffolding for the multi-stage (Phase 4 Task 10) test suite:
// `TestOwner` wraps the keyed `StageState` and tracks the id of the most
// recently opened stage, so single-stage tests keep passing `&TestOwner` to
// the same helpers as before. `TestEvents` filters the (stage_id, paths)
// emissions to the watched stage (any stage by default).

#![allow(dead_code)]

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use usdbee_lib::stage::{
    request_edit_target, request_stage_details, EditTargetInfo, StageInfo, StageRequest, StageState,
};
use usdbee_lib::values::PrimDetails;

pub struct TestOwner {
    pub state: StageState,
    id: Cell<u64>,
}

impl TestOwner {
    pub fn id(&self) -> u64 {
        self.id.get()
    }

    /// The sender of the most recently opened stage; panics when none is.
    pub fn sender(&self) -> mpsc::Sender<StageRequest> {
        self.state
            .sender(self.id.get())
            .expect("a stage should be open")
    }

    pub fn mesh_tessellations(&self) -> usize {
        self.state
            .mesh_tessellations(self.id.get())
            .expect("a stage should be open")
    }

    /// Switch the owner's idle-gap warmup off (dev/test hook, `None` on the
    /// app side) and drop what it warmed, so the cache counters and the frame
    /// cache below are the test's own.
    pub fn disable_warmup(&self) {
        usdbee_lib::stage::request_set_warmup_enabled(&self.sender(), false)
            .expect("warmup should switch off");
    }

    /// Block until the owner's idle-gap warmup has pre-evaluated every authored
    /// time code. Once it returns, the process-wide cache counters belong to the
    /// test's own requests again — the point of waiting rather than sleeping.
    /// A stage whose manifest skeleton no one built yet never queues (see
    /// `warm_one_step`), so ask for a manifest first.
    pub fn wait_for_warmup(&self) {
        let sender = self.sender();
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let (warmed, total) =
                usdbee_lib::stage::request_warmup_progress(&sender).expect("progress should reply");
            if total > 0 && warmed >= total {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "warmup stalled at {warmed}/{total}"
            );
        }
    }

    pub fn stage_tree_serializations(&self) -> usize {
        self.state
            .stage_tree_serializations(self.id.get())
            .expect("a stage should be open")
    }

    pub fn pose_frame_hits(&self) -> usize {
        self.state
            .pose_frame_hits(self.id.get())
            .expect("a stage should be open")
    }

    /// Open a stage through the full flow (is_usdz origin flag, source
    /// archive, cleanup-owned extraction dir) and track its id.
    pub fn open_flow(
        &self,
        path: &Path,
        is_usdz: bool,
        source_usdz: Option<&Path>,
        extraction_dir: Option<&Path>,
    ) -> StageInfo {
        let info = self
            .state
            .open(path, is_usdz, source_usdz, extraction_dir)
            .unwrap_or_else(|e| panic!("stage {} should open: {}", path.display(), e));
        self.id.set(info.stage_id);
        info
    }

    pub fn open(&self, path: &Path) -> StageInfo {
        self.open_flow(path, false, None, None)
    }

    /// An open whose failure the test asserts; on failure the tracked id
    /// stays on the previously opened stage.
    pub fn try_open(&self, path: &Path) -> Result<StageInfo, String> {
        self.state.open(path, false, None, None)
    }
}

pub struct TestEvents {
    rx: mpsc::Receiver<(u64, Vec<String>)>,
    filter: Cell<Option<u64>>,
    last_id: Cell<u64>,
}

impl TestEvents {
    /// Only pass through events of this stage.
    pub fn watch(&self, id: u64) {
        self.filter.set(Some(id));
    }

    /// Pass through events of any stage.
    pub fn watch_any(&self) {
        self.filter.set(None);
    }

    /// The stage id of the most recently received emission.
    pub fn last_id(&self) -> u64 {
        self.last_id.get()
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<Vec<String>, mpsc::RecvTimeoutError> {
        loop {
            let (id, paths) = self.rx.recv_timeout(timeout)?;
            self.last_id.set(id);
            if self.filter.get().is_some_and(|filter| filter != id) {
                continue;
            }
            return Ok(paths);
        }
    }
}

fn owner_with_sink(sink: usdbee_lib::stage::StageEventSink) -> TestOwner {
    TestOwner {
        state: StageState::new(sink),
        id: Cell::new(0),
    }
}

pub fn spawn_stage_owner() -> TestOwner {
    owner_with_sink(usdbee_lib::stage::noop_sink())
}

pub fn owner_with_events() -> (TestOwner, TestEvents) {
    let (event_tx, event_rx) = mpsc::channel();
    let owner = owner_with_sink(Arc::new(move |id: u64, paths: &[String]| {
        let _ = event_tx.send((id, paths.to_vec()));
    }));
    let events = TestEvents {
        rx: event_rx,
        filter: Cell::new(None),
        last_id: Cell::new(0),
    };
    (owner, events)
}

pub fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

pub fn open_path_via_owner(state: &TestOwner, path: &Path) -> StageInfo {
    state.open(path)
}

pub fn open_via_owner(state: &TestOwner, name: &str) {
    state.open(&fixture(name));
}

pub fn details_via_owner(state: &TestOwner, path: &str, time: Option<f64>) -> PrimDetails {
    request_stage_details(&state.sender(), path, time).expect("details should serialize")
}

pub fn attribute<'a>(
    details: &'a PrimDetails,
    name: &str,
) -> &'a usdbee_lib::values::AttributeInfo {
    details
        .attributes
        .iter()
        .find(|a| a.name == name)
        .unwrap_or_else(|| panic!("expected attribute {} in {:?}", name, details.attributes))
}

pub fn request_set_value(
    state: &TestOwner,
    path: &str,
    name: &str,
    value: usdbee_lib::values::ValuePayload,
    time: Option<f64>,
) -> Result<(), String> {
    usdbee_lib::stage::request_set_attribute_value(&state.sender(), path, name, &value, time)
}

pub fn payload(r#type: &str, data: serde_json::Value) -> usdbee_lib::values::ValuePayload {
    usdbee_lib::values::ValuePayload {
        r#type: r#type.to_string(),
        data,
        truncated: None,
        count: None,
    }
}

pub fn edit_target(state: &TestOwner) -> EditTargetInfo {
    request_edit_target(&state.sender()).expect("edit target should serialize")
}

pub fn request_undo(state: &TestOwner) -> Result<bool, String> {
    usdbee_lib::stage::request_undo(&state.sender())
}

pub fn request_redo(state: &TestOwner) -> Result<bool, String> {
    usdbee_lib::stage::request_redo(&state.sender())
}

pub fn undo_state(state: &TestOwner) -> usdbee_lib::stage::UndoState {
    usdbee_lib::stage::request_undo_state(&state.sender()).expect("undo state should serialize")
}

pub fn request_set_variant_selection(
    state: &TestOwner,
    path: &str,
    variant_set: &str,
    selection: Option<&str>,
) -> Result<(), String> {
    usdbee_lib::stage::request_set_variant_selection(&state.sender(), path, variant_set, selection)
}

pub fn variant_set<'a>(
    details: &'a PrimDetails,
    name: &str,
) -> &'a usdbee_lib::values::VariantSetInfo {
    details
        .variant_sets
        .iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| {
            panic!(
                "expected variant set {} in {:?}",
                name, details.variant_sets
            )
        })
}
