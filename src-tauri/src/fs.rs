use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
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

#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<FileNode>, String> {
    let mut nodes: Vec<FileNode> = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
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
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    atomic_write(Path::new(&path), &contents)
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("file already exists".into());
    }
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename(path: String, new_path: String) -> Result<(), String> {
    fs::rename(&path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

/// Watch a workspace root and emit debounced `fs-changed` events.
/// One watcher at a time; starting a new watch replaces the old.
#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    root: String,
    state: State<'_, Mutex<WatchState>>,
) -> Result<(), String> {
    let app = app.clone();
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
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.watcher = Some(watcher); // dropping the old one un-watches it
    st.root = Some(PathBuf::from(&root));
    drop(st);

    // Collector thread: batch paths, emit at most every 300 ms of quiet.
    std::thread::spawn(move || {
        let mut pending: Vec<String> = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(path) => {
                    let s = path.to_string_lossy().to_string();
                    // Ignore our own atomic-write temp files.
                    if !s.contains(".tmp") {
                        pending.push(s);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() {
                        pending.dedup();
                        let _ = app.emit("fs-changed", &pending);
                        pending.clear();
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Ok(())
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
    fs::write(&file, serde_json::to_string(&list).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = config_path(&app, "settings.json")?;
    Ok(fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({})))
}

#[tauri::command]
pub fn settings_set(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let path = config_path(&app, "settings.json")?;
    fs::write(&path, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn path_dir(path: String) -> String {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn path_join(dir: String, name: String) -> String {
    PathBuf::from(&dir).join(name).to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_never_leaves_temp_files() {
        let dir = std::env::temp_dir().join("notepad-test-atomic");
        fs::create_dir_all(&dir).unwrap();
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
        let dir = std::env::temp_dir().join("notepad-test-atomic2");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.md");
        for i in 0..25 {
            atomic_write(&target, &format!("v{i}")).unwrap();
            assert_eq!(fs::read_to_string(&target).unwrap(), format!("v{i}"));
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
