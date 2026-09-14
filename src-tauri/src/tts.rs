use crate::pick::Cmd;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::process::Child;

/// Read-aloud via the `edge-tts` CLI (Microsoft neural voices).
/// ponytail: detect-and-use like pandoc — no bundled TTS, no websocket
/// reimplementation of the Edge protocol. Ceiling: single synth at a time,
/// ~30k chars per request; add streaming chunking if long-doc reading lags.
/// Ceiling: the xdg-open fallback hands the file to the desktop default app
/// and exits immediately, so Stop cannot kill that playback (mpv/ffplay can).

pub struct TtsState {
    synth: Mutex<Option<Child>>,
    player: Mutex<Option<Child>>,
}

pub fn tts_state() -> TtsState {
    TtsState { synth: Mutex::new(None), player: Mutex::new(None) }
}

/// Kill any synth/player children. Called from Stop and from app exit
/// (children used to survive the app).
pub fn shutdown(state: &TtsState) {
    stop_internal(state);
}

#[tauri::command]
pub fn tts_available() -> bool {
    std::process::Command::new("edge-tts")
        .arg("--help")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn tts_voices(on_result: Channel<Cmd<Vec<String>>>) {
    tauri::async_runtime::spawn(async move {
        let out = (async {
            let proc_out = tokio::process::Command::new("edge-tts")
                .arg("--list-voices")
                .output()
                .await
                .map_err(|e| format!("edge-tts not found: {e}"))?;
            if !proc_out.status.success() {
                return Err("edge-tts --list-voices failed".into());
            }
            let text = String::from_utf8_lossy(&proc_out.stdout);
            // Lines look like: "en-US-AriaNeural    Female    ..." — first token is the name.
            Ok::<Vec<String>, String>(text
                .lines()
                .skip(1) // header row
                .filter_map(|l| l.split_whitespace().next())
                .filter(|s| s.contains('-'))
                .map(String::from)
                .collect())
        })
        .await;
        let out = match out {
            Ok(v) => Cmd { ok: true, value: v, error: None },
            Err(e) => Cmd { ok: false, value: Vec::new(), error: Some(e) },
        };
        let _ = on_result.send(out);
    });
}

fn kill_locked(slot: &mut Option<Child>) {
    if let Some(mut child) = slot.take() {
        let _ = child.start_kill();
    }
}

fn stop_internal(state: &TtsState) {
    if let Ok(mut s) = state.synth.lock() {
        kill_locked(&mut s);
    }
    if let Ok(mut p) = state.player.lock() {
        kill_locked(&mut p);
    }
}

/// Stop any in-flight synthesis and playback.
#[tauri::command]
pub fn tts_stop(state: State<'_, TtsState>) {
    stop_internal(&state);
}

/// Synthesize `text` with edge-tts, then play the audio with the first
/// available player. Channel-delivered (async responses don't resolve on this
/// WebKitGTK build). Resolves once playback starts (or on error).
/// `rate`/`volume` are like "+10%"/"-5%", `pitch` like "+20Hz"/"-10Hz".
#[tauri::command]
pub fn tts_speak(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    rate: Option<String>,
    pitch: Option<String>,
    volume: Option<String>,
    on_result: Channel<Cmd<bool>>,
) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<TtsState>();
        let out = match speak_inner(&text, voice, rate, pitch, volume, &state).await {
            Ok(()) => Cmd { ok: true, value: true, error: None },
            Err(e) => Cmd { ok: false, value: false, error: Some(e) },
        };
        let _ = on_result.send(out);
    });
}

/// Accept only `[+-]<digits><suffix>` — these strings become argv values, and
/// the joined `--opt=value` form keeps a leading `-` out of flag position.
fn valid_tts_param(s: &str, suffix: &str) -> bool {
    let num = s.strip_suffix(suffix).unwrap_or("");
    let num = num.strip_prefix('+').or_else(|| num.strip_prefix('-')).unwrap_or(num);
    !num.is_empty() && num.chars().all(|c| c.is_ascii_digit())
}

async fn speak_inner(
    text: &str,
    voice: Option<String>,
    rate: Option<String>,
    pitch: Option<String>,
    volume: Option<String>,
    state: &TtsState,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("nothing to read".into());
    }
    // ponytail: hard cap — edge-tts degrades on very long single requests.
    let text = text.chars().take(30_000).collect::<String>();
    stop_internal(state);
    cleanup_old_temp_files();

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = std::env::temp_dir();
    // predictable-name + symlink-following + never-cleaned: fixed by using an
    // exclusive per-request name and a janitor sweep (below).
    let txt = dir.join(format!("notepad-tts-{stamp}-{}.txt", std::process::id()));
    let mp3 = dir.join(format!("notepad-tts-{stamp}-{}.mp3", std::process::id()));
    std::fs::write(&txt, &text).map_err(|e| e.to_string())?;

    let txt2 = txt.clone();
    let mp32 = mp3.clone();
    let voice = voice.unwrap_or_else(|| "en-US-AriaNeural".into());
    let mut cmd = tokio::process::Command::new("edge-tts");
    cmd.arg("--file").arg(&txt2)
        .arg("--voice").arg(&voice)
        .arg("--write-media").arg(&mp32);
    for (value, suffix, flag) in [
        (rate, "%", "--rate"),
        (pitch, "Hz", "--pitch"),
        (volume, "%", "--volume"),
    ] {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            if !valid_tts_param(&v, suffix) {
                let _ = std::fs::remove_file(&txt);
                return Err(format!("invalid {flag} value: {v}"));
            }
            // Joined form: "--rate=-10%" — a bare "-10%" would parse as a flag.
            cmd.arg(format!("{flag}={v}"));
        }
    }
    let synth = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // If the task is dropped mid-flight, take the child down with it.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("edge-tts not found: {e}"))?;

    *state.synth.lock().map_err(|e| e.to_string())? = Some(synth);

    // Poll for completion without holding the lock across .await, so
    // tts_stop can take and kill the child mid-synthesis.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        {
            let mut s = state.synth.lock().map_err(|e| e.to_string())?;
            match s.as_mut() {
                // Slot emptied by tts_stop.
                None => {
                    let _ = std::fs::remove_file(&txt);
                    return Err("stopped".into());
                }
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        *s = None;
                        let _ = std::fs::remove_file(&txt);
                        if !status.success() {
                            return Err("speech synthesis failed".into());
                        }
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        *s = None;
                        let _ = std::fs::remove_file(&txt);
                        return Err(e.to_string());
                    }
                },
            }
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = std::fs::remove_file(&txt);
            return Err("speech synthesis timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }

    // Pick a player: mpv → ffplay → xdg-open (default media app).
    let play = |prog: &str, args: &[&str]| -> Option<Child> {
        tokio::process::Command::new(prog)
            .args(args)
            .arg(&mp3)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()
    };
    let player = play("mpv", &["--no-video", "--really-quiet"])
        .or_else(|| play("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet"].as_slice()))
        .or_else(|| play("xdg-open", &[]));
    match player {
        Some(child) => {
            *state.player.lock().map_err(|e| e.to_string())? = Some(child);
            // ponytail: the mp3 outlives playback (the player may still read
            // it); the janitor removes stale files after an hour.
            Ok(())
        }
        None => {
            let _ = std::fs::remove_file(&mp3);
            Err("no audio player found (install mpv or ffplay)".into())
        }
    }
}

/// Remove notepad-tts temp files older than an hour. Document text used to
/// sit in /tmp forever.
fn cleanup_old_temp_files() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(3600);
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("notepad-tts-") {
            continue;
        }
        if let Ok(meta) = e.metadata() {
            let modified = meta.modified().unwrap_or(std::time::SystemTime::now());
            if modified < cutoff {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::valid_tts_param;

    #[test]
    fn tts_param_validation() {
        assert!(valid_tts_param("+10%", "%"));
        assert!(valid_tts_param("-5%", "%"));
        assert!(valid_tts_param("0%", "%"));
        assert!(valid_tts_param("+20Hz", "Hz"));
        // Flag-shaped or garbage values are rejected.
        assert!(!valid_tts_param("--file=/etc/passwd", "%"));
        assert!(!valid_tts_param("10", "%"));
        assert!(!valid_tts_param("", "%"));
        assert!(!valid_tts_param("abc%", "%"));
    }
}
