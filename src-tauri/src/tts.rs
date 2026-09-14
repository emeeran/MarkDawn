use std::sync::Mutex;
use std::time::Duration;
use tauri::State;
use tokio::process::Child;

/// Read-aloud via the `edge-tts` CLI (Microsoft neural voices).
/// ponytail: detect-and-use like pandoc — no bundled TTS, no websocket
/// reimplementation of the Edge protocol. Ceiling: single synth at a time,
/// ~30k chars per request; add streaming chunking if long-doc reading lags.

pub struct TtsState {
    synth: Mutex<Option<Child>>,
    player: Mutex<Option<Child>>,
}

pub fn tts_state() -> TtsState {
    TtsState { synth: Mutex::new(None), player: Mutex::new(None) }
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
pub async fn tts_voices() -> Result<Vec<String>, String> {
    let out = tokio::process::Command::new("edge-tts")
        .arg("--list-voices")
        .output()
        .await
        .map_err(|e| format!("edge-tts not found: {e}"))?;
    if !out.status.success() {
        return Err("edge-tts --list-voices failed".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Lines look like: "en-US-AriaNeural    Female    ..." — first token is the name.
    Ok(text
        .lines()
        .skip(1) // header row
        .filter_map(|l| l.split_whitespace().next())
        .filter(|s| s.contains('-'))
        .map(String::from)
        .collect())
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
/// available player. Returns immediately after starting playback.
#[tauri::command]
pub async fn tts_speak(
    text: String,
    voice: Option<String>,
    state: State<'_, TtsState>,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("nothing to read".into());
    }
    // ponytail: hard cap — edge-tts degrades on very long single requests.
    let text = text.chars().take(30_000).collect::<String>();
    stop_internal(&state);

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = std::env::temp_dir();
    let txt = dir.join(format!("notepad-tts-{stamp}.txt"));
    let mp3 = dir.join(format!("notepad-tts-{stamp}.mp3"));
    std::fs::write(&txt, &text).map_err(|e| e.to_string())?;

    let txt2 = txt.clone();
    let mp32 = mp3.clone();
    let voice = voice.unwrap_or_else(|| "en-US-AriaNeural".into());
    let synth = tokio::process::Command::new("edge-tts")
        .args(["--file", &txt2.to_string_lossy(), "--voice", &voice, "--write-media", &mp32.to_string_lossy()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
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
                None => return Err("stopped".into()),
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        *s = None;
                        if !status.success() {
                            return Err("speech synthesis failed".into());
                        }
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        *s = None;
                        return Err(e.to_string());
                    }
                },
            }
        }
        if tokio::time::Instant::now() >= deadline {
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
            .spawn()
            .ok()
    };
    let player = play("mpv", &["--no-video", "--really-quiet"])
        .or_else(|| play("ffplay", &["-nodisp", "-autoexit", "-loglevel", "quiet"]))
        .or_else(|| play("xdg-open", &[]));
    match player {
        Some(child) => {
            *state.player.lock().map_err(|e| e.to_string())? = Some(child);
            Ok(())
        }
        None => Err("no audio player found (install mpv or ffplay)".into()),
    }
}
