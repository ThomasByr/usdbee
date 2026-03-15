mod commands;
mod fetcher;
mod models;
mod omniverse;
mod parser;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Manager,
};

fn build_system_menu(app: &tauri::AppHandle) -> tauri::menu::Menu<tauri::Wry> {
    let open_item = MenuItemBuilder::with_id("file_open", "Open USD File...")
        .accelerator("CmdOrCtrl+O")
        .build(app)
        .unwrap();

    let file_submenu = SubmenuBuilder::new(app, "File")
        .item(&open_item)
        .build()
        .unwrap();

    MenuBuilder::new(app).item(&file_submenu).build().unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let initial_url = omniverse::load_omniverse_url_from_disk();
            app.manage(omniverse::AppState {
                omniverse_server: std::sync::Mutex::new(initial_url),
            });

            let handle = app.handle();
            let menu = build_system_menu(handle);
            app.set_menu(menu)?;

            app.on_menu_event(move |app_handle, event| {
                if event.id() == "file_open" {
                    let app_clone = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = commands::trigger_open_usd_dialog(app_clone).await;
                    });
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::trigger_open_usd_dialog,
            commands::set_fallback_color,
            omniverse::set_omniverse_url,
            omniverse::get_omniverse_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
