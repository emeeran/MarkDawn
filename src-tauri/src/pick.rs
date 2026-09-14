use serde::Serialize;
use tauri::command;
use tauri::ipc::Channel;

/// Native file/folder pickers.
/// ponytail: tauri-plugin-dialog (rfd) hangs pre-map on some Linux setups
/// (observed on this machine), so prefer zenity/kdialog and fall back to the
/// plugin in JS. Commands are SYNC + Channel: async-command responses never
/// resolve on this WebKitGTK build (frontend awaits via Channel instead).

#[derive(Serialize)]
pub struct Cmd<T> {
    pub ok: bool,
    pub value: T,
    pub error: Option<String>,
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned())
}

/// Runs a picker; Ok(None) = cancelled, Err("unavailable") = program missing.
async fn run(prog: &str, args: &[String]) -> Result<Option<String>, String> {
    let out = match tokio::process::Command::new(prog).args(args).output().await {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("unavailable".into()),
        Err(e) => return Err(e.to_string()),
    };
    if !out.status.success() {
        return Ok(None); // cancelled
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        Ok(None)
    } else {
        Ok(Some(path))
    }
}

async fn pick(kind: &str, default_name: Option<String>) -> Result<Option<String>, String> {
    let home_dir = home();
    let mut tools: Vec<(&'static str, Vec<String>)> = Vec::new();
    match (kind, default_name.as_deref()) {
        ("folder", _) => {
            tools.push(("zenity", vec!["--file-selection".into(), "--directory".into()]));
            tools.push(("kdialog", vec!["--getexistingdirectory".into(), home_dir.clone()]));
        }
        ("file", _) => {
            tools.push(("zenity", vec!["--file-selection".into()]));
            tools.push(("kdialog", vec!["--getopenfilename".into(), home_dir.clone()]));
        }
        ("save", Some(name)) => {
            let kdialog_start = format!("{home_dir}/{name}");
            tools.push((
                "zenity",
                vec!["--file-selection".into(), "--save".into(), "--filename".into(), name.into()],
            ));
            tools.push(("kdialog", vec!["--getsavefilename".into(), kdialog_start]));
        }
        _ => return Err("bad pick kind".into()),
    }
    let mut last = String::from("no picker available");
    for (prog, args) in tools {
        match run(prog, &args).await {
            Ok(result) => return Ok(result),
            Err(e) if e == "unavailable" => last = e,
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

fn spawn_pick(kind: &'static str, default_name: Option<String>, on_result: Channel<Cmd<Option<String>>>) {
    tauri::async_runtime::spawn(async move {
        let out = match pick(kind, default_name).await {
            Ok(v) => Cmd { ok: true, value: v, error: None },
            Err(e) => Cmd { ok: false, value: None, error: Some(e) },
        };
        let _ = on_result.send(out);
    });
}

#[command]
pub fn pick_folder(on_result: Channel<Cmd<Option<String>>>) {
    spawn_pick("folder", None, on_result);
}

#[command]
pub fn pick_file(on_result: Channel<Cmd<Option<String>>>) {
    spawn_pick("file", None, on_result);
}

#[command]
pub fn pick_save(default_name: String, on_result: Channel<Cmd<Option<String>>>) {
    spawn_pick("save", Some(default_name), on_result);
}
