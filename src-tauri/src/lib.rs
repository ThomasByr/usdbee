mod commands;
mod fetcher;
pub use fetcher::get_usdbee_cache_dir;
pub mod materials;
mod models;
mod omniverse;
pub mod parser;
pub mod stage;
pub mod tessellation;
pub mod values;

use tauri::Emitter;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Manager,
};

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

    MenuBuilder::new(app).item(&file_submenu).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
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
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::trigger_open_usd_dialog,
            commands::set_fallback_color,
            commands::read_file_bytes,
            commands::save_file_bytes,
            stage::open_usd_path,
            stage::close_stage,
            stage::list_stages,
            stage::get_stage_tree,
            stage::get_prim_details,
            stage::get_scene_manifest,
            stage::get_geometry_data,
            stage::get_geometry_batch,
            stage::get_material_data,
            stage::set_attribute_value,
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
            omniverse::get_omniverse_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
