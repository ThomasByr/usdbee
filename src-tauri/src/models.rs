use std::collections::HashMap;

#[derive(serde::Serialize, Clone, Debug)]
pub struct UsdDependencyNode {
    pub path: String,
    pub resolved: bool,
    pub size_bytes: Option<u64>,
    pub fallback_color: Option<String>,
    pub error_msg: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct UsdSceneData {
    pub root_file: String,
    // The frontend attributes usd-stage-opened by this id: the root layer
    // identifier is canonicalized (\\?\ on Windows) while root_file is not.
    pub stage_id: u64,
    pub dependencies: HashMap<String, UsdDependencyNode>,
}

#[derive(serde::Serialize, Clone)]
pub struct ProgressEvent {
    pub stage: String,
    pub percent: u8,
}
