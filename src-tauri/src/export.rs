use crate::pick::Cmd;
use tauri::command;
use tauri::ipc::Channel;

/// SYNC command — async-command responses don't resolve on this WebKitGTK
/// build. Runs off-thread with a hard timeout (same pattern as the clipboard
/// commands in fs.rs): a hung pandoc (nfs home, broken install) must not
/// freeze the UI while it waits.
#[command]
pub fn pandoc_available() -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        tx.send(
            std::process::Command::new("pandoc")
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false),
        )
        .ok();
    });
    rx.recv_timeout(std::time::Duration::from_secs(3))
        .unwrap_or(false)
}

/// Convert a saved Markdown file with pandoc. Channel-delivered (async
/// responses don't resolve on this build). Value = destination path.
#[command]
pub fn export_pandoc(
    src: String,
    format: String,
    on_result: Channel<Cmd<String>>,
    guard: tauri::State<'_, crate::fs::FsGuard>,
) {
    // Same confinement as every other file-touching command: both the read
    // and the write must be inside the consented scope. Checked before the
    // spawn (State cannot cross it).
    let check = (|guard: &crate::fs::FsGuard| -> Result<(), String> {
        let dest = match src.rsplit_once('.') {
            Some((stem, _)) => format!("{stem}.{format}"),
            None => format!("{src}.{format}"),
        };
        guard.check(&std::path::PathBuf::from(&src))?;
        guard.check(&std::path::PathBuf::from(&dest))
    })(&guard);
    if let Err(e) = check {
        let _ = on_result.send(Cmd::err(e));
        return;
    }
    tauri::async_runtime::spawn(async move {
        let out = match run_pandoc(src, format).await {
            Ok(dest) => Cmd::ok(dest),
            Err(e) => Cmd::err(e),
        };
        let _ = on_result.send(out);
    });
}

async fn run_pandoc(src: String, format: String) -> Result<String, String> {
    // Keep in sync with the Export menu/registry — only expose what the UI offers.
    const FORMATS: [&str; 5] = ["docx", "rtf", "odt", "latex", "epub"];
    if !FORMATS.contains(&format.as_str()) {
        return Err(format!("unsupported format: {format}"));
    }
    let dest = match src.rsplit_once('.') {
        Some((stem, _)) => format!("{stem}.{format}"),
        None => format!("{src}.{format}"),
    };
    let dest_path = std::path::PathBuf::from(&dest);
    // Never silently clobber an existing file the user may care about.
    if dest_path.exists() {
        return Err(format!("{dest} already exists — remove or rename it first"));
    }
    // Atomic-ish: pandoc writes a temp file in the destination directory and
    // it is renamed over the target only on success (a failed pandoc must not
    // leave a partial document behind).
    let tmp = dest_path.with_extension(format!("pandoc-tmp.{format}"));
    let _ = std::fs::remove_file(&tmp);
    let tmp2 = tmp.clone();
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new("pandoc")
            .args(["-f", "markdown", "-t", &format, "-o"])
            .arg(&tmp2)
            .arg(&src)
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("pandoc failed: {}", err.trim()));
    }
    std::fs::rename(&tmp, &dest_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(dest)
}
