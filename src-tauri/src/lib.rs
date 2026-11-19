mod app_info;
pub mod cameras;
mod cli;
mod commands;
mod fetcher;
pub use commands::{open_usd_file_path, LoadGate, OPEN_IN_FLIGHT_MESSAGE};
pub use fetcher::get_usdbee_cache_dir;
pub mod lights;
pub mod materials;
mod models;
mod omniverse;
pub use omniverse::AppState;
pub mod parser;
pub mod skinning;
pub mod stage;
pub mod tessellation;
mod updater_prefs;
pub mod values;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Manager,
};

// The menu emits events the page listens for, so a click that lands before the
// page mounts would be lost. The page calls `frontend_ready` once its listeners
// are registered. A click that arrives before that is held in `pending_about`
// (the last one wins) and flushed by that call.
struct FrontendReady {
    ready: AtomicBool,
    pending_about: std::sync::Mutex<Option<AboutRequest>>,
}

// `check` starts an update check; `full` picks the About dialog over the
// compact update one.
#[derive(Clone, Copy, serde::Serialize)]
struct AboutRequest {
    check: bool,
    full: bool,
}

fn emit_open_about(app: &tauri::AppHandle, request: AboutRequest) {
    if let Err(e) = app.emit("open-about", request) {
        eprintln!("Failed to emit open-about: {}", e);
    }
}

fn self_update_supported(os: &str, appimage: Option<&str>) -> bool {
    os != "linux" || appimage.is_some()
}

#[tauri::command]
fn is_self_update_supported() -> bool {
    self_update_supported(
        std::env::consts::OS,
        std::env::var("APPIMAGE").ok().as_deref(),
    )
}

#[tauri::command]
fn frontend_ready(app: tauri::AppHandle, state: tauri::State<'_, FrontendReady>) {
    // Flag and flush under one lock: a click landing between the two lands in
    // `pending_about` before the take, or sees the flag after it.
    let pending = {
        let mut pending_about = state
            .pending_about
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        state.ready.store(true, Ordering::SeqCst);
        pending_about.take()
    };
    if let Some(request) = pending {
        emit_open_about(&app, request);
    }
}

fn build_system_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let open_item = MenuItemBuilder::with_id("file_open", "Open USD File...")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;

    let export_item = MenuItemBuilder::with_id("file_export", "Export...")
        .accelerator("CmdOrCtrl+E")
        .build(app)?;

    let save_item = MenuItemBuilder::with_id("file_save", "Save...")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;

    let file_submenu = SubmenuBuilder::new(app, "File")
        .item(&open_item)
        .item(&save_item)
        .item(&export_item)
        .build()?;

    let check_updates =
        MenuItemBuilder::with_id("about_check_updates", "Check for Updates...").build(app)?;
    let auto_check =
        CheckMenuItemBuilder::with_id("about_auto_check", "Check automatically on startup")
            .checked(updater_prefs::stored_auto_check(app))
            .build(app)?;
    let about_info = MenuItemBuilder::with_id("about_info", "About usdbee").build(app)?;

    let about_submenu = SubmenuBuilder::new(app, "About")
        .item(&check_updates)
        .item(&auto_check)
        .separator()
        .item(&about_info)
        .build()?;

    MenuBuilder::new(app)
        .item(&file_submenu)
        .item(&about_submenu)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if cli::wants_help(&args) {
        println!("{}", cli::USAGE);
        std::process::exit(0);
    }
    let launch_options = match cli::parse_launch_args(&args) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            app.manage(launch_options);
            app.manage(LoadGate::default());
            app.manage(FrontendReady {
                ready: AtomicBool::new(false),
                pending_about: std::sync::Mutex::new(None),
            });
            let handle = app.handle().clone();
            app.manage(stage::StageState::new(std::sync::Arc::new(
                move |stage_id: u64, paths: &[String]| {
                    if let Err(e) = handle.emit(
                        "usd-stage-changed",
                        serde_json::json!({ "stage_id": stage_id, "paths": paths }),
                    ) {
                        eprintln!("usdbee: failed to emit usd-stage-changed: {}", e);
                    }
                },
            )));
            let initial_url = omniverse::load_omniverse_url_from_disk();
            app.manage(omniverse::AppState {
                omniverse_server: std::sync::Mutex::new(initial_url),
            });

            let handle = app.handle();
            let menu = build_system_menu(handle)?;
            app.set_menu(menu)?;

            app.on_menu_event(move |app_handle, event| {
                println!("Menu event: {:?}", event.id());
                if event.id() == "file_open" {
                    let app_clone = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = commands::trigger_open_usd_dialog(app_clone).await;
                    });
                } else if event.id() == "file_save" {
                    if let Err(e) = app_handle.emit("open-save-dialog", "show") {
                        eprintln!("Failed to emit open-save-dialog: {}", e);
                    }
                } else if event.id() == "file_export" {
                    println!("Emitting open-export-modal to frontend...");
                    if let Err(e) = app_handle.emit("open-export-modal", "show") {
                        println!("Failed to emit open-export-modal: {}", e);
                    }
                } else if event.id() == "about_auto_check" {
                    // The click already flipped the native tick; persist what it now shows.
                    // A failed read must not be written back as "off": that would drop the
                    // user's preference.
                    let Some(item) = updater_prefs::auto_check_tick(app_handle) else {
                        eprintln!("Failed to read the startup check preference");
                        return;
                    };
                    let enabled = match item.is_checked() {
                        Ok(checked) => checked,
                        Err(e) => {
                            eprintln!("Failed to read the startup check preference: {e}");
                            return;
                        }
                    };
                    if let Err(e) = updater_prefs::apply_auto_check(app_handle, enabled) {
                        eprintln!("Failed to save the startup check preference: {e}");
                    }
                } else if event.id() == "about_check_updates" || event.id() == "about_info" {
                    let request = AboutRequest {
                        check: event.id() == "about_check_updates",
                        full: event.id() == "about_info",
                    };
                    let state = app_handle.state::<FrontendReady>();
                    let mut pending_about = state
                        .pending_about
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if !state.ready.load(Ordering::SeqCst) {
                        *pending_about = Some(request);
                        return;
                    }
                    drop(pending_about);
                    emit_open_about(app_handle, request);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::trigger_open_usd_dialog,
            commands::open_usd_file_path,
            commands::set_fallback_color,
            commands::read_file_bytes,
            commands::save_file_bytes,
            commands::suggest_dir_entries,
            stage::open_usd_path,
            stage::close_stage,
            stage::list_stages,
            stage::get_stage_tree,
            stage::get_prim_details,
            stage::get_scene_manifest,
            stage::get_time_codes,
            stage::get_geometry_data,
            stage::get_geometry_batch,
            stage::get_animated_pose,
            stage::get_animated_pose_batch,
            stage::get_material_data,
            stage::get_material_batch,
            stage::get_stage_lights,
            stage::get_stage_cameras,
            stage::set_attribute_value,
            stage::set_attribute_values,
            stage::set_prim_metadata,
            stage::set_variant_selection,
            stage::set_prim_texture,
            stage::get_edit_target,
            stage::set_edit_target,
            stage::list_dirty_layers,
            stage::save_layers,
            stage::save_stage_as_usdz,
            stage::undo_stage_edit,
            stage::redo_stage_edit,
            stage::get_undo_state,
            stage::export_layer_text,
            stage::import_layer_text,
            stage::list_stage_layers,
            omniverse::set_omniverse_url,
            omniverse::get_omniverse_url,
            cli::get_launch_options,
            is_self_update_supported,
            frontend_ready,
            app_info::app_build_info,
            updater_prefs::get_update_auto_check,
            updater_prefs::set_update_auto_check
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod updater_support_tests {
    use super::self_update_supported;

    #[test]
    fn windows_and_macos_always_support_self_update() {
        assert!(self_update_supported("windows", None));
        assert!(self_update_supported("macos", None));
    }

    #[test]
    fn linux_supports_self_update_only_inside_appimage() {
        assert!(!self_update_supported("linux", None));
        assert!(self_update_supported("linux", Some("/tmp/usdbee.AppImage")));
    }
}
