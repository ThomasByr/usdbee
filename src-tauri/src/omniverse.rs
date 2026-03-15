use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub struct AppState {
    pub omniverse_server: Mutex<String>,
}

fn get_settings_path() -> PathBuf {
    let mut dir = dirs::data_local_dir().unwrap_or_else(|| std::env::temp_dir());
    dir.push("usdbee");
    dir.push("settings_omni.txt");
    dir
}

pub fn load_omniverse_url_from_disk() -> String {
    let path = get_settings_path();
    if let Ok(content) = fs::read_to_string(&path) {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "http://localhost:34080".to_string()
}

pub fn save_omniverse_url_to_disk(url: &str) {
    let path = get_settings_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, url);
}

#[tauri::command]
pub fn set_omniverse_url(url: String, state: State<'_, AppState>) {
    let mut st = state.omniverse_server.lock().unwrap();
    *st = url.clone();
    save_omniverse_url_to_disk(&url);
}

#[tauri::command]
pub fn get_omniverse_url(state: State<'_, AppState>) -> String {
    state.omniverse_server.lock().unwrap().clone()
}

pub fn resolve_omniverse_uri(uri: &str, server_url: &str) -> String {
    let trimmed = uri.trim();
    for prefix in &["omni://", "omniverse://"] {
        if let Some(stripped) = trimmed.strip_prefix(prefix) {
            let parts: Vec<&str> = stripped.splitn(2, '/').collect();
            if parts.len() == 2 {
                let path = parts[1];
                let base = server_url.trim_end_matches('/');
                return format!("{}/omni/{}", base, path);
            }
        }
    }
    uri.to_string()
}
