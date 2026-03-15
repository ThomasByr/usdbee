use std::collections::HashMap;

#[derive(serde::Serialize, Clone)]
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
    pub dependencies: HashMap<String, UsdDependencyNode>,
}

#[derive(serde::Serialize, Clone)]
pub struct ProgressEvent {
    pub stage: String,
    pub percent: u8,
}
