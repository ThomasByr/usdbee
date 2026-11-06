// Shared scaffolding for the multi-stage (Phase 4 Task 10) test suite:
// `TestOwner` wraps the keyed `StageState` and tracks the id of the most
// recently opened stage, so single-stage tests keep passing `&TestOwner` to
// the same helpers as before. `TestEvents` filters the (stage_id, paths)
// emissions to the watched stage (any stage by default).

#![allow(dead_code)]

use std::cell::Cell;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use usdbee_lib::stage::{StageInfo, StageRequest, StageState};

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

    pub fn stage_tree_serializations(&self) -> usize {
        self.state
            .stage_tree_serializations(self.id.get())
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
