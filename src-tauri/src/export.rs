use tauri::command;

const FORMATS: [&str; 7] = ["docx", "rtf", "odt", "latex", "rst", "epub", "org"];

#[command]
pub fn pandoc_available() -> bool {
    std::process::Command::new("pandoc")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Convert a saved Markdown file with pandoc. Returns the destination path.
#[command]
pub async fn export_pandoc(src: String, format: String) -> Result<String, String> {
    if !FORMATS.contains(&format.as_str()) {
        return Err(format!("unsupported format: {format}"));
    }
    let dest = match src.rsplit_once('.') {
        Some((stem, _)) => format!("{stem}.{format}"),
        None => format!("{src}.{format}"),
    };
    let src2 = src.clone();
    let dest2 = dest.clone();
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new("pandoc")
            .args(["-f", "markdown", "-t", &format, "-o", &dest2, &src2])
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
