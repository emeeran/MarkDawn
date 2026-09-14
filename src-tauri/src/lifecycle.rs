use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

/// Force-exit fallback: once a quit is intercepted and handed to the webview
/// to flush saves, this is armed; if the webview never answers (crashed),
/// we exit anyway after a delay rather than hanging the app.
pub static QUIT_ARMED: AtomicBool = AtomicBool::new(false);
static STARTUP_FILES: OnceLock<Vec<String>> = OnceLock::new();

/// Markdown paths passed to the very first launch (`notepad foo.md`). The
/// single-instance callback covers *subsequent* launches; this covers the
/// first, which used to silently drop the argument.
fn collect_startup_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| a.ends_with(".md") && std::path::Path::new(a).is_file())
        .collect()
}

pub fn init_startup_files() {
    let _ = STARTUP_FILES.set(collect_startup_files());
}

#[tauri::command]
pub fn startup_files() -> Vec<String> {
    STARTUP_FILES.get().cloned().unwrap_or_default()
}

/// Called by the webview after it flushed pending saves in response to
/// `quit-requested`.
#[tauri::command]
pub fn quit_now(app: AppHandle) {
    QUIT_ARMED.store(false, Ordering::SeqCst);
    app.exit(0);
}

/// Intercept a user quit (no explicit exit code), tell the webview to flush
/// debounced saves, then exit when it answers `quit_now` (or force-exit after
/// a grace period if the webview is dead).
pub fn handle_exit_requested(app: &AppHandle, code: Option<i32>, api: &tauri::ExitRequestApi) {
    if code.is_some() {
        return; // explicit exit (our own quit_now) passes through untouched
    }
    let already_armed = QUIT_ARMED.swap(true, Ordering::SeqCst);
    if !already_armed {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            if QUIT_ARMED.load(Ordering::SeqCst) {
                // Webview never answered — exit anyway.
                handle.exit(1);
            }
        });
    }
    api.prevent_exit();
    let _ = app.emit("quit-requested", ());
}
