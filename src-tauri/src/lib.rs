mod ai_proxy;
mod export;
mod fs;
mod lifecycle;
mod menu;
mod pick;
mod secrets;
mod tts;

use tauri::{Emitter, Manager, RunEvent};

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
        .setup(|app| {
            let handle = app.handle().clone();
            menu::install(&handle)?;
            fs::seed_guard(&handle);
            lifecycle::init_startup_files();
            Ok(())
        })
        .manage(ai_proxy::streams())
        .manage(fs::watch_state())
        .manage(fs::fs_guard())
        .manage(tts::tts_state())
        .invoke_handler(tauri::generate_handler![
            fs::fs_allow,
            fs::read_dir,
            fs::read_file,
            fs::write_file,
            fs::create_file,
            fs::create_dir,
            fs::rename,
            fs::trash_path,
            fs::image_import,
            fs::image_save_bytes,
            fs::save_recovery,
            fs::watch_start,
            fs::watch_stop,
            fs::recent_get,
            fs::recent_push,
            fs::recent_clear,
            fs::settings_get,
            fs::settings_set,
            fs::store_get,
            fs::store_set,
            fs::path_dir,
            fs::path_join,
            fs::workspace_search,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::secret_status,
            ai_proxy::ai_stream,
            ai_proxy::ai_cancel,
            ai_proxy::ollama_models,
            ai_proxy::fetch_models,
            export::pandoc_available,
            export::export_pandoc,
            pick::pick_folder,
            pick::pick_file,
            pick::pick_save,
            tts::tts_available,
            tts::tts_voices,
            tts::tts_speak,
            tts::tts_stop,
            lifecycle::startup_files,
            lifecycle::quit_now,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Notepad")
        .run(|app, event| {
            if let RunEvent::ExitRequested { code, ref api, .. } = event {
                lifecycle::handle_exit_requested(app, code, api);
            }
            if let RunEvent::Exit = event {
                // Children (synth/player) used to outlive the app.
                if let Some(w) = app.get_webview_window("main") {
                    let state = w.app_handle().state::<tts::TtsState>();
                    tts::shutdown(&state);
                }
            }
        });
}
