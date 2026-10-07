use crate::pick::Cmd;
use tauri::ipc::Channel;
use tauri::command;

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
    rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap_or(false)
}

/// Convert a saved Markdown file with pandoc. Channel-delivered (async
/// responses don't resolve on this build). Value = destination path.
#[command]
pub fn export_pandoc(src: String, format: String, on_result: Channel<Cmd<String>>) {
    tauri::async_runtime::spawn(async move {
        let out = match run_pandoc(src, format).await {
            Ok(dest) => Cmd { ok: true, value: dest, error: None },
            Err(e) => Cmd { ok: false, value: String::new(), error: Some(e) },
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
    // Never silently clobber an existing file the user may care about.
    if std::path::Path::new(&dest).exists() {
        return Err(format!("{dest} already exists — remove or rename it first"));
    }
    let dest2 = dest.clone();
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new("pandoc")
            .args(["-f", "markdown", "-t", &format, "-o", &dest2, &src])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("pandoc failed: {}", err.trim()));
    }
    Ok(dest)
}
