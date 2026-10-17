use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

/// Force-exit fallback: once a quit is intercepted and handed to the webview
/// to flush saves, this is armed with a deadline; a live webview extends the
/// deadline while it flushes (`quit_extend`) and a slow-but-alive flush is
/// never killed. If the webview never answers (crashed), the deadline passes
/// and we exit anyway rather than hanging the app. `quit_disarm` cancels the
/// whole thing when the webview REFUSES to quit (failed saves) — the buffers
/// the flush protects must not be destroyed by the guard itself.
pub static QUIT_ARMED: AtomicBool = AtomicBool::new(false);
static QUIT_DEADLINE_MS: AtomicU64 = AtomicU64::new(0);
static STARTUP_FILES: OnceLock<Vec<String>> = OnceLock::new();

/// Document extensions we accept from argv ("Open With" passes any of these).
/// Keep in sync with the bundle fileAssociations in tauri.conf.json.
pub fn is_document_arg(arg: &str) -> bool {
    ["md", "markdown", "txt"]
        .iter()
        .any(|ext| arg.to_lowercase().ends_with(&format!(".{ext}")))
}

/// Document paths passed to the very first launch (`markdawn foo.md`). The
/// single-instance callback covers *subsequent* launches; this covers the
/// first, which used to silently drop the argument.
fn collect_startup_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| is_document_arg(a) && std::path::Path::new(a).is_file())
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

/// Extend the force-exit deadline. The webview calls this on an interval
/// while its flush is running, so a slow-but-alive flush is never killed;
/// a dead webview stops extending and the deadline passes.
#[tauri::command]
pub fn quit_extend() {
    extend_deadline();
}

/// Cancel the pending force-exit without exiting: the webview refused to
/// quit (failed saves). Arming the guard must never destroy the very buffers
/// it protects.
#[tauri::command]
pub fn quit_disarm() {
    QUIT_ARMED.store(false, Ordering::SeqCst);
}

fn extend_deadline() {
    QUIT_DEADLINE_MS.store(
        crate::fs::epoch_ms() + FORCE_EXIT_AFTER_MS,
        Ordering::SeqCst,
    );
}

const FORCE_EXIT_AFTER_MS: u64 = 3_000;

/// Intercept a user quit (no explicit exit code), tell the webview to flush
/// debounced saves, then exit when it answers `quit_now` (or force-exit after
/// a grace period if the webview is dead).
pub fn handle_exit_requested(app: &AppHandle, code: Option<i32>, api: &tauri::ExitRequestApi) {
    if code.is_some() {
        return; // explicit exit (our own quit_now) passes through untouched
    }
    let already_armed = QUIT_ARMED.swap(true, Ordering::SeqCst);
    if !already_armed {
        extend_deadline();
        let handle = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if !QUIT_ARMED.load(Ordering::SeqCst) {
                return; // disarmed or already exited
            }
            if crate::fs::epoch_ms() >= QUIT_DEADLINE_MS.load(Ordering::SeqCst) {
                // Webview never answered (and stopped extending) — exit anyway.
                handle.exit(1);
            }
        });
    } else {
        extend_deadline();
    }
    api.prevent_exit();
    let _ = app.emit("quit-requested", ());
}
