use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize)]
pub struct FileNode {
    name: String,
    path: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

pub struct WatchState {
    watcher: Option<RecommendedWatcher>,
    #[allow(dead_code)] // handle kept alive so the collector thread stays joined-able
    root: Option<PathBuf>,
}

/// Managed-state constructor (keeps internals private to this module).
pub fn watch_state() -> WatchState {
    WatchState { watcher: None, root: None }
}

/// Atomic write: temp file in the same directory, then rename over the target.
/// A crash mid-write can never leave a half-written document.
pub(crate) fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "invalid path".to_string())?;
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "notepad".into())
    ));
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Confinement: which paths the webview may touch through fs commands.
/// Seeded with the app's own config/data dirs; grown via `fs_allow` when the
/// user picks a file/folder, opens a workspace, or drops/launches into a file.
/// Without this, any script in the webview reads/writes the whole disk.
pub struct FsGuard {
    roots: Arc<Mutex<Vec<PathBuf>>>,
}

pub fn fs_guard() -> FsGuard {
    FsGuard { roots: Arc::new(Mutex::new(Vec::new())) }
}

/// Lexical cleanup of `.` and `..` without requiring the path to exist.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_within(root: &Path, p: &Path) -> bool {
    p.starts_with(root)
}

/// Best-effort canonicalization: falls back to canonicalizing the deepest
/// existing ancestor, so not-yet-created files resolve against a real root.
/// ponytail: lexical normalize + ancestor canonicalize does not follow
/// symlinks that appear *after* allowance; re-canonicalize if that threat
/// model ever matters.
fn canonicalize_best_effort(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    let mut anc = p.to_path_buf();
    while let Some(parent) = anc.parent() {
        if let Ok(c) = parent.canonicalize() {
            return c.join(anc.file_name().unwrap_or_default());
        }
        anc = parent.to_path_buf();
    }
    normalize(p)
}

impl FsGuard {
    fn allow(&self, path: &Path) {
        let c = canonicalize_best_effort(path);
        if let Ok(mut roots) = self.roots.lock() {
            if !roots.contains(&c) {
                roots.push(c);
            }
        }
    }

    fn check(&self, path: &Path) -> Result<(), String> {
        let c = canonicalize_best_effort(path);
        let roots = self.roots.lock().map_err(|e| e.to_string())?;
        if roots.iter().any(|r| is_within(r, &c)) {
            Ok(())
        } else {
            Err(format!("path outside the allowed scope: {}", path.display()))
        }
    }
}

/// Allow a path for both fs commands and the asset protocol (image display).
/// Called by the frontend after any user-consented pick/drop/launch.
#[tauri::command]
pub fn fs_allow(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let guard = app.state::<FsGuard>();
    guard.allow(&p);
    let c = canonicalize_best_effort(&p);
    // Display-time image resolution goes through asset:// — extend its scope
    // too (recursive so `<doc>_assets/` subdirectories resolve).
    let scope = app.asset_protocol_scope();
    if c.is_dir() {
        let _ = scope.allow_directory(&c, true);
        guard.allow(&c); // read_dir on the folder itself
    } else {
        let _ = scope.allow_file(&c);
        if let Some(parent) = c.parent() {
            let _ = scope.allow_directory(parent, true);
            guard.allow(parent);
        }
    }
    Ok(())
}

/// Seed the guard with the app's own storage so settings/chat stores work
/// before any file is opened. Called once from setup.
pub fn seed_guard(app: &AppHandle) {
    let guard = app.state::<FsGuard>();
    for dir in [app.path().app_config_dir().ok(), app.path().app_data_dir().ok()].into_iter().flatten() {
        guard.allow(&dir);
    }
}

#[tauri::command]
pub fn read_dir(path: String, guard: State<'_, FsGuard>) -> Result<Vec<FileNode>, String> {
    let p = PathBuf::from(&path);
    guard.check(&p)?;
    let mut nodes: Vec<FileNode> = Vec::new();
    for entry in fs::read_dir(&p).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map_err(|e| e.to_string())?.is_dir();
        nodes.push(FileNode {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
        });
    }
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(nodes)
}

#[tauri::command]
pub fn read_file(path: String, guard: State<'_, FsGuard>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    guard.check(&p)?;
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String, guard: State<'_, FsGuard>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    guard.check(&p)?;
    atomic_write(&p, &contents)
}

#[tauri::command]
pub fn create_file(path: String, guard: State<'_, FsGuard>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    guard.check(&p)?;
    if p.exists() {
        return Err("file already exists".into());
    }
    fs::write(&p, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir(path: String, guard: State<'_, FsGuard>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    guard.check(&p)?;
    fs::create_dir_all(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename(path: String, new_path: String, guard: State<'_, FsGuard>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let np = PathBuf::from(&new_path);
    guard.check(&p)?;
    guard.check(&np)?;
    fs::rename(&p, &np).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trash_path(path: String, guard: State<'_, FsGuard>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    guard.check(&p)?;
    trash::delete(&p).map_err(|e| e.to_string())
}

/// Copy a dropped/picked image into `<doc>_assets/` next to the document and
/// return the portable relative path for the Markdown.
#[tauri::command]
pub fn image_import(app: AppHandle, doc_dir: String, src: String) -> Result<String, String> {
    let dir = PathBuf::from(&doc_dir);
    app.state::<FsGuard>().check(&dir)?;
    let src_path = PathBuf::from(&src);
    app.state::<FsGuard>().check(&src_path)?;
    let ext = src_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .filter(|e| ["png", "jpg", "jpeg", "gif", "svg", "webp"].contains(&e.as_str()))
        .ok_or_else(|| "unsupported image type".to_string())?;
    import_image_inner(&dir, ext, |dest| fs::copy(&src_path, dest).map(|_| ()).map_err(|e| e.to_string()))
}

/// Write a pasted (clipboard) image into `<doc>_assets/`; `bytes` is the raw
/// encoded image (png/jpeg/…), not raw pixels.
#[tauri::command]
pub fn image_save_bytes(
    app: AppHandle,
    doc_dir: String,
    ext: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let dir = PathBuf::from(&doc_dir);
    app.state::<FsGuard>().check(&dir)?;
    let ext = ext.to_lowercase();
    if !["png", "jpg", "jpeg", "gif", "svg", "webp"].contains(&ext.as_str()) {
        return Err("unsupported image type".into());
    }
    import_image_inner(&dir, ext, |dest| fs::write(dest, bytes.as_slice()).map_err(|e| e.to_string()))
}

fn import_image_inner(
    doc_dir: &Path,
    ext: String,
    write: impl Fn(&Path) -> Result<(), String>,
) -> Result<String, String> {
    let stem = doc_dir
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".into());
    let assets = doc_dir.join(format!("{stem}_assets"));
    fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    for i in 0..10_000u32 {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let name = if i == 0 {
            format!("image-{stamp}.{ext}")
        } else {
            format!("image-{stamp}-{i}.{ext}")
        };
        let dest = assets.join(&name);
        if !dest.exists() {
            write(&dest)?;
            // Make the new image renderable (and guard-allowed) immediately.
            return Ok(format!("{stem}_assets/{name}"));
        }
    }
    Err("could not find a free image name".into())
}

/// Last-resort save for dirty *untitled* tabs during quit (nothing to save
/// them to). Goes to app-data/recovery/, never touches user folders.
#[tauri::command]
pub fn save_recovery(app: AppHandle, title: String, contents: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("recovery");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let safe: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let path = dir.join(format!("{safe}-{stamp}.md"));
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// --- clipboard image paste ---------------------------------------------------
//
// WebKitGTK's DataTransferItem.getAsFile() returns null for images copied from
// system apps (file managers, viewers), so the webview alone can't paste
// them. Read the clipboard from the OS instead: xclip on X11, wl-paste on
// Wayland. ponytail: CLI clipboard readers, not a gtk bindings dependency;
// on macOS/Windows the JS clipboard path works and this is only a fallback.

/// Grab the clipboard image (if any), save it next to the document, and
/// return the portable relative path. None = no image on the clipboard.
#[tauri::command]
pub fn paste_image(app: AppHandle, doc_dir: String) -> Result<Option<String>, String> {
    let dir = PathBuf::from(&doc_dir);
    app.state::<FsGuard>().check(&dir)?;
    let Some((bytes, ext)) = read_clipboard_image() else {
        return Ok(None);
    };
    import_image_inner(&dir, ext, |dest| fs::write(dest, bytes.as_slice()).map_err(|e| e.to_string()))
        .map(Some)
}

/// One local image as a data: URL for editor display. The asset:// protocol
/// proved unreliable on this WebKitGTK build, so the webview renders images
/// from data URLs while the Markdown keeps portable relative paths.
/// ponytail: whole-file in memory per render; cap keeps a stray paste from
/// exhausting the webview — add streaming/disk cache if docs embed big media.
#[tauri::command]
pub fn image_data(path: String, guard: State<'_, FsGuard>) -> Result<String, String> {
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    const MIME_BY_EXT: [(&str, &str); 6] = [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("gif", "image/gif"),
        ("webp", "image/webp"),
        ("svg", "image/svg+xml"),
    ];
    let p = PathBuf::from(&path);
    guard.check(&p)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("image too large to display".into());
    }
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = MIME_BY_EXT
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, m)| *m)
        .ok_or_else(|| "unsupported image type".to_string())?;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// Read the clipboard image via the OS tooling. Runs off-thread with a hard
/// timeout: xclip occasionally wedges waiting on the X selection, and this is
/// a sync command on the main thread — a hang here would freeze the app.
/// ponytail: on timeout the reader thread leaks until its child exits; rare
/// and harmless, vs. adding async+Channel plumbing for a fallback path.
fn read_clipboard_image() -> Option<(Vec<u8>, String)> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        tx.send(read_clipboard_image_inner()).ok();
    });
    rx.recv_timeout(Duration::from_secs(3)).unwrap_or(None)
}

fn read_clipboard_image_inner() -> Option<(Vec<u8>, String)> {
    // (program, args, extension) — first attempt that yields non-empty output wins.
    let attempts: [(&str, Vec<&str>, &str); 4] = [
        ("wl-paste", vec!["--no-newline", "--type", "image/png"], "png"),
        ("wl-paste", vec!["--no-newline", "--type", "image/jpeg"], "jpg"),
        ("xclip", vec!["-selection", "clipboard", "-o", "-t", "image/png"], "png"),
        ("xclip", vec!["-selection", "clipboard", "-o", "-t", "image/jpeg"], "jpg"),
    ];
    for (prog, args, ext) in attempts {
        let Ok(out) = std::process::Command::new(prog)
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
        else {
            continue; // tool not installed
        };
        if out.status.success() && !out.stdout.is_empty() {
            return Some((out.stdout, ext.to_string()));
        }
    }
    None
}

/// Watch a workspace root and emit debounced `fs-changed` events.
/// One watcher at a time; starting a new watch replaces the old.
#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    root: String,
    state: State<'_, Mutex<WatchState>>,
    guard: State<'_, FsGuard>,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    guard.check(&root_path)?;
    guard.allow(&root_path);
    let app2 = app.clone();
    let (tx, rx) = mpsc::channel::<std::path::PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            for path in event.paths {
                let _ = tx.send(path);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.watcher = Some(watcher); // dropping the old one un-watches it
    st.root = Some(root_path);
    drop(st);

    // Watched trees may contain images the editor renders — allow the whole
    // asset scope for the workspace (recursive).
    let _ = app2.asset_protocol_scope().allow_directory(&canonicalize_best_effort(Path::new(&root)), true);

    // Collector thread: batch paths, emit at most every 300 ms of quiet.
    std::thread::spawn(move || {
        let mut pending: Vec<String> = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(path) => {
                    let s = path.to_string_lossy().to_string();
                    // Ignore our own atomic-write temp files (`.name.tmp`).
                    if !is_own_temp_file(&s) {
                        pending.push(s);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() {
                        pending.dedup();
                        let _ = app2.emit("fs-changed", &pending);
                        pending.clear();
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Ok(())
}

/// True only for our atomic-write temp files (`.anything.tmp`), not for
/// legitimate files that merely contain ".tmp" somewhere in the name.
fn is_own_temp_file(path: &str) -> bool {
    path.rsplit(['/', '\\'])
        .next()
        .map(|name| name.starts_with('.') && name.ends_with(".tmp"))
        .unwrap_or(false)
}

#[tauri::command]
pub fn watch_stop(state: State<'_, Mutex<WatchState>>) {
    if let Ok(mut st) = state.lock() {
        st.watcher = None;
        st.root = None;
    }
}

fn config_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

#[tauri::command]
pub fn recent_get(app: AppHandle) -> Result<Vec<String>, String> {
    let path = config_path(&app, "recent.json")?;
    Ok(fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

#[tauri::command]
pub fn recent_push(app: AppHandle, path: String) -> Result<(), String> {
    let file = config_path(&app, "recent.json")?;
    let mut list: Vec<String> = fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(15);
    // Atomic: a crash mid-write used to truncate the whole recents file.
    atomic_write(&file, &serde_json::to_string(&list).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn recent_clear(app: AppHandle) -> Result<(), String> {
    let file = config_path(&app, "recent.json")?;
    atomic_write(&file, "[]")
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Result<serde_json::Value, String> {
    store_get(app, "settings".into())
}

#[tauri::command]
pub fn settings_set(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    store_set(app, "settings".into(), settings)
}

/// Generic named JSON store in the app config dir (settings, chat history, …).
#[tauri::command]
pub fn store_get(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    let path = config_path(&app, &store_file_name(&name)?)?;
    Ok(fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({})))
}

#[tauri::command]
pub fn store_set(app: AppHandle, name: String, value: serde_json::Value) -> Result<(), String> {
    let path = config_path(&app, &store_file_name(&name)?)?;
    atomic_write(&path, &serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?)
}

fn store_file_name(name: &str) -> Result<String, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid store name".into());
    }
    Ok(format!("{name}.json"))
}

#[tauri::command]
pub fn path_dir(path: String) -> String {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Join a *single* filename onto a directory. The name is a component, not a
/// path: separators and `..` are rejected (they were a traversal primitive).
#[tauri::command]
pub fn path_join(dir: String, name: String) -> Result<String, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(format!("invalid file name: {name}"));
    }
    Ok(PathBuf::from(&dir).join(name).to_string_lossy().to_string())
}

// --- workspace-wide text search --------------------------------------------

#[derive(Serialize, Clone)]
pub struct SearchHit {
    path: String,
    line: String,
    #[serde(rename = "lineNo")]
    line_no: usize,
}

const SEARCH_SKIP_DIRS: [&str; 4] = [".git", "node_modules", "target", "dist"];
const SEARCH_EXTS: [&str; 3] = ["md", "markdown", "txt"];
const MAX_SEARCH_HITS: usize = 200;
const MAX_SEARCH_FILES: usize = 4_000;
const MAX_SEARCH_DEPTH: usize = 12;
const MAX_SEARCH_FILE_BYTES: u64 = 512 * 1024;

/// Literal substring search across the workspace's text files.
/// ponytail: case-folded substring match, no regex — covers the actual need
/// without pulling in a regex/grep dependency; the in-document find bar has
/// regex if it's wanted.
#[tauri::command]
pub fn workspace_search(
    root: String,
    query: String,
    case_sensitive: bool,
    guard: State<'_, FsGuard>,
    on_result: Channel<crate::pick::Cmd<Vec<SearchHit>>>,
) {
    let root_path = PathBuf::from(&root);
    let allowed = guard.check(&root_path).is_ok();
    tauri::async_runtime::spawn(async move {
        let out = if !allowed {
            Err("folder is not in the allowed scope".to_string())
        } else if query.is_empty() {
            Ok(Vec::new())
        } else {
            let needle = if case_sensitive { query.clone() } else { query.to_lowercase() };
            let mut hits = Vec::new();
            let mut visited = 0usize;
            walk_search(&root_path, &needle, case_sensitive, 0, &mut visited, &mut hits);
            Ok(hits)
        };
        let result = match out {
            Ok(v) => crate::pick::Cmd { ok: true, value: v, error: None },
            Err(e) => crate::pick::Cmd { ok: false, value: Vec::new(), error: Some(e) },
        };
        let _ = on_result.send(result);
    });
}

fn walk_search(dir: &Path, needle: &str, case_sensitive: bool, depth: usize, visited: &mut usize, hits: &mut Vec<SearchHit>) {
    if depth > MAX_SEARCH_DEPTH || hits.len() >= MAX_SEARCH_HITS || *visited >= MAX_SEARCH_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if hits.len() >= MAX_SEARCH_HITS || *visited >= MAX_SEARCH_FILES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if !name.starts_with('.') && !SEARCH_SKIP_DIRS.contains(&name.as_str()) {
                walk_search(&entry.path(), needle, case_sensitive, depth + 1, visited, hits);
            }
            continue;
        }
        if !SEARCH_EXTS.contains(&name.rsplit('.').next().unwrap_or_default().to_lowercase().as_str()) {
            continue;
        }
        *visited += 1;
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else { continue }; // binary → skip
        let path = entry.path().to_string_lossy().to_string();
        let mut per_file = 0usize;
        for (i, line) in text.lines().enumerate() {
            let hay = if case_sensitive { line } else { &line.to_lowercase() };
            if hay.contains(needle) {
                hits.push(SearchHit { path: path.clone(), line: line.to_string(), line_no: i + 1 });
                per_file += 1;
                if hits.len() >= MAX_SEARCH_HITS || per_file >= 20 {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("notepad-test-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_never_leaves_temp_files() {
        let dir = tmpdir("atomic");
        let target = dir.join("doc.md");
        fs::write(&target, "old").unwrap();

        atomic_write(&target, "new contents").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new contents");

        // No .tmp litter in the directory.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn atomic_write_overwrites_repeatedly() {
        let dir = tmpdir("atomic2");
        let target = dir.join("doc.md");
        for i in 0..25 {
            atomic_write(&target, &format!("v{i}")).unwrap();
            assert_eq!(fs::read_to_string(&target).unwrap(), format!("v{i}"));
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn normalize_resolves_dotdot_lexically() {
        let p = normalize(Path::new("/ws/sub/../other/f.md"));
        assert_eq!(p, PathBuf::from("/ws/other/f.md"));
        // Escaping above root collapses to root, never reverses.
        assert_eq!(normalize(Path::new("/ws/../../etc")), PathBuf::from("/etc"));
    }

    #[test]
    fn guard_allows_within_and_blocks_outside() {
        let ws = tmpdir("guard-ws");
        let outside = tmpdir("guard-out");
        let g = FsGuard { roots: Arc::new(Mutex::new(Vec::new())) };
        g.allow(&ws);

        assert!(g.check(&ws.join("note.md")).is_ok());
        assert!(g.check(&ws.join("sub/dir/deep.md")).is_ok());
        // Traversal that resolves back inside is fine; outside is not.
        assert!(g.check(&ws.join("../guard-out/secret.md")).is_err());
        assert!(g.check(&outside.join("secret.md")).is_err());

        // Allowing a file covers its parent dir too (save-as-adjacent flows).
        let f = ws.join("doc.md");
        g.allow(&f);
        assert!(g.check(&ws.join("other.md")).is_ok());

        fs::remove_dir_all(&ws).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn temp_file_filter_matches_only_our_pattern() {
        assert!(is_own_temp_file("/ws/.doc.md.tmp"));
        assert!(is_own_temp_file("/ws/.x.tmp"));
        assert!(!is_own_temp_file("/ws/notes.backup.tmp")); // starts without dot
        assert!(!is_own_temp_file("/ws/my.tmp.notes.md")); // contains, not suffix
        assert!(!is_own_temp_file("/ws/.hidden"));
    }

    #[test]
    fn path_join_rejects_traversal_and_separators() {
        assert_eq!(path_join("/ws".into(), "a.md".into()).unwrap(), "/ws/a.md");
        assert!(path_join("/ws".into(), "../escape.md".into()).is_err());
        assert!(path_join("/ws".into(), "sub/a.md".into()).is_err());
        assert!(path_join("/ws".into(), "a\\b.md".into()).is_err());
        assert!(path_join("/ws".into(), "..".into()).is_err());
        assert!(path_join("/ws".into(), String::new()).is_err());
    }

    #[test]
    fn store_name_is_validated() {
        assert!(store_file_name("chat-history").is_ok());
        assert!(store_file_name("../etc/passwd").is_err());
        assert!(store_file_name("a b").is_err());
    }
}
