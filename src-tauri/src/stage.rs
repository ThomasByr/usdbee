use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;

use openusd::ar::DefaultResolver;
use openusd::usd::{InitialLoadSet, PrimPredicate, Stage};
use serde::{Deserialize, Serialize};

use crate::fetcher::get_usdbee_cache_dir;

pub enum StageRequest {
    Open {
        path: PathBuf,
        reply: mpsc::Sender<Result<StageInfo, String>>,
    },
}

pub struct StageState {
    pub sender: mpsc::Sender<StageRequest>,
}

pub fn spawn_stage_owner() -> StageState {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut _current_stage = None;
        while let Ok(request) = receiver.recv() {
            match request {
                StageRequest::Open { path, reply } => {
                    let response = catch_unwind(AssertUnwindSafe(|| {
                        let (stage, info) = open_stage(&path)?;
                        _current_stage = Some(stage);
                        Ok(info)
                    }))
                    .unwrap_or_else(|payload| {
                        let message = payload
                            .downcast_ref::<&str>()
                            .map(|message| (*message).to_owned())
                            .or_else(|| payload.downcast_ref::<String>().cloned())
                            .unwrap_or_else(|| "unknown panic".to_string());
                        Err(format!("internal stage error: {}", message))
                    });
                    let _ = reply.send(response);
                }
            }
        }
    });
    StageState { sender }
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
