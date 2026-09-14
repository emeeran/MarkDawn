mod ai_proxy;
mod export;
mod fs;
mod secrets;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second launch: focus the existing window and forward any file arg.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
                for a in argv.iter().skip(1) {
                    if a.ends_with(".md") {
                        let _ = app.emit("open-path", a.to_string());
                    }
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(ai_proxy::abort_map())
        .manage(fs::watch_state())
        .invoke_handler(tauri::generate_handler![
            fs::read_dir,
            fs::read_file,
            fs::write_file,
            fs::create_file,
            fs::create_dir,
            fs::rename,
            fs::trash_path,
            fs::watch_start,
            fs::watch_stop,
            fs::recent_get,
            fs::recent_push,
            fs::settings_get,
            fs::settings_set,
            fs::path_exists,
            fs::path_dir,
            fs::path_join,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::secret_status,
            ai_proxy::ai_stream,
            ai_proxy::ai_cancel,
            ai_proxy::ollama_models,
            export::pandoc_available,
            export::export_pandoc,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Notepad");
}
