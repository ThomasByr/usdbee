// The one file that remembers whether usdbee checks for updates on startup.
// A missing or unreadable file means "off": a broken preference must never
// start a network call the user did not ask for.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, MenuItemKind};
use tauri::{AppHandle, Manager};

const AUTO_CHECK_ID: &str = "about_auto_check";
const PREFS_FILE: &str = "updater.json";

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UpdaterPrefs {
    #[serde(default)]
    pub auto_check: bool,
}

pub fn read_prefs(path: &Path) -> UpdaterPrefs {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn write_prefs(path: &Path, prefs: &UpdaterPrefs) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| format!("Failed to encode the updater preferences: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve the config directory: {e}"))?;
    Ok(dir.join(PREFS_FILE))
}

// `Menu::get` only searches top-level items and the tick lives in the About
// submenu, so the lookup walks one level down.
pub(crate) fn auto_check_tick(app: &AppHandle) -> Option<CheckMenuItem<tauri::Wry>> {
    for item in app.menu()?.items().ok()? {
        match item {
            MenuItemKind::Check(check) if check.id() == AUTO_CHECK_ID => return Some(check),
            MenuItemKind::Submenu(submenu) => {
                // One unreadable submenu must not hide the item. It lives in About.
                for child in submenu.items().unwrap_or_default() {
                    if let MenuItemKind::Check(check) = child {
                        if check.id() == AUTO_CHECK_ID {
                            return Some(check);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

pub(crate) fn stored_auto_check(app: &AppHandle) -> bool {
    prefs_path(app)
        .map(|path| read_prefs(&path).auto_check)
        .unwrap_or(false)
}

// The only writer of `updater.json`: the settings command and the menu tick
// both land here, so the file and the tick cannot disagree.
pub(crate) fn apply_auto_check(app: &AppHandle, enabled: bool) -> Result<(), String> {
    write_prefs(
        &prefs_path(app)?,
        &UpdaterPrefs {
            auto_check: enabled,
        },
    )?;
    if let Some(item) = auto_check_tick(app) {
        item.set_checked(enabled)
            .map_err(|e| format!("Failed to update the menu tick: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_update_auto_check(app: AppHandle) -> Result<bool, String> {
    Ok(stored_auto_check(&app))
}

#[tauri::command]
pub fn set_update_auto_check(app: AppHandle, enabled: bool) -> Result<(), String> {
    apply_auto_check(&app, enabled)
}

#[cfg(test)]
mod tests {
    use super::{read_prefs, write_prefs, UpdaterPrefs};

    #[test]
    fn round_trips_the_flag() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("updater.json");

        write_prefs(&path, &UpdaterPrefs { auto_check: true }).unwrap();

        assert!(read_prefs(&path).auto_check);
    }

    #[test]
    fn missing_file_means_off() {
        let dir = tempfile::tempdir().unwrap();

        assert!(!read_prefs(&dir.path().join("updater.json")).auto_check);
    }

    #[test]
    fn corrupt_file_means_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("updater.json");
        std::fs::write(&path, "not json").unwrap();

        assert!(!read_prefs(&path).auto_check);
    }
}
