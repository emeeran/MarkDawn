use crate::pick::Cmd;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::process::Child;

/// Read-aloud via the `edge-tts` CLI (Microsoft neural voices).
/// ponytail: detect-and-use like pandoc — no bundled TTS, no websocket
/// reimplementation of the Edge protocol. Ceiling: ~30k chars per request;
/// synths run concurrently (the frontend prefetches ahead); add streaming
/// chunking if long-doc reading lags.
/// Ceiling: the xdg-open fallback hands the file to the desktop default app
/// and exits immediately, so Stop cannot kill that playback (mpv/ffplay can).

/// Slot entries carry the owning request's generation: when a newer request
/// replaces the slot, the superseded task's poll loop must NOT poll (or
/// clear) its successor's child — it used to, returning success for an mp3
/// that was never written and stopping the survivor.
pub struct TtsState {
    /// In-flight synthesis children, keyed by request generation. Several run
    /// concurrently (the frontend prefetches ahead); tts_stop drains the map.
    synth: Mutex<std::collections::HashMap<u64, Child>>,
    player: Mutex<Option<(u64, Child)>>,
}

fn next_gen() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::SeqCst)
}

pub fn tts_state() -> TtsState {
    TtsState {
        synth: Mutex::new(std::collections::HashMap::new()),
        player: Mutex::new(None),
    }
}

/// Desktop sessions inherit PATH from the systemd user environment, which
/// typically omits `~/.local/bin` — where pip installs edge-tts. Dev shells
/// have it, the installed app doesn't. Search PATH, then the pip default.
fn edge_tts_candidates() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(std::path::PathBuf::from(home).join(".local").join("bin"));
    }
    dirs.into_iter().map(|d| d.join("edge-tts")).collect()
}

/// Resolved per spawn (cheap stats): picking up an edge-tts installed after
/// app launch must not require a restart.
fn edge_tts_path() -> std::path::PathBuf {
    edge_tts_candidates()
        .into_iter()
        .find(|p| p.is_file())
        // Not found anywhere: fall back to the bare name so spawn fails with
        // the existing "edge-tts not found" error path.
        .unwrap_or_else(|| std::path::PathBuf::from("edge-tts"))
}

/// Kill any synth/player children. Called from Stop and from app exit
/// (children used to survive the app).
pub fn stop_internal(state: &TtsState) {
    drain_synths(state);
    if let Ok(mut p) = state.player.lock() {
        kill_locked(&mut p);
    }
}

/// Off-thread with a hard timeout (same pattern as the clipboard commands in
/// fs.rs): edge-tts is a Python script whose cold import can take seconds —
/// that must never block the main thread.
#[tauri::command]
pub fn tts_available() -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        tx.send(
            std::process::Command::new(edge_tts_path())
                .arg("--help")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false),
        )
        .ok();
    });
    rx.recv_timeout(Duration::from_secs(5)).unwrap_or(false)
}

#[tauri::command]
pub fn tts_voices(on_result: Channel<Cmd<Vec<String>>>) {
    tauri::async_runtime::spawn(async move {
        let out = (async {
            let proc_out = tokio::process::Command::new(edge_tts_path())
                .arg("--list-voices")
                .output()
                .await
                .map_err(|e| format!("edge-tts not found: {e}"))?;
            if !proc_out.status.success() {
                return Err("edge-tts --list-voices failed".into());
            }
            let text = String::from_utf8_lossy(&proc_out.stdout);
            // Lines look like: "en-US-AriaNeural    Female    ..." — first token is the name.
            Ok::<Vec<String>, String>(
                text.lines()
                    .skip(1) // header row
                    .filter_map(|l| l.split_whitespace().next())
                    .filter(|s| s.contains('-'))
                    .map(String::from)
                    .collect(),
            )
        })
        .await;
        let out = match out {
            Ok(v) => Cmd::ok(v),
            Err(e) => Cmd::err(e),
        };
        let _ = on_result.send(out);
    });
}

fn kill_locked(slot: &mut Option<(u64, Child)>) {
    if let Some((_, mut child)) = slot.take() {
        let _ = child.start_kill();
    }
}

fn drain_synths(state: &TtsState) {
    if let Ok(mut s) = state.synth.lock() {
        for (_, mut child) in s.drain() {
            let _ = child.start_kill();
        }
    }
}

/// Stop any in-flight synthesis and playback.
#[tauri::command]
pub fn tts_stop(state: State<'_, TtsState>) {
    stop_internal(&state);
}

/// Synthesize `text` with edge-tts into a temp mp3; resolves with its path.
/// The frontend prefetches the next sentence's synth while the current one
/// plays, so only this command touches the synth slot. Channel-delivered
/// (async responses don't resolve on this WebKitGTK build).
/// `rate`/`volume` are like "+10%"/"-5%", `pitch` like "+20Hz"/"-10Hz".
#[tauri::command]
pub fn tts_synth(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    rate: Option<String>,
    pitch: Option<String>,
    volume: Option<String>,
    on_result: Channel<Cmd<String>>,
) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<TtsState>();
        let out = match synth_inner(&text, voice, rate, pitch, volume, &state).await {
            Ok(path) => Cmd::ok(path.to_string_lossy().into_owned()),
            Err(e) => Cmd::err(e),
        };
        let _ = on_result.send(out);
    });
}

/// Play a previously synthesized mp3. Resolves when playback FINISHES (or
/// "stopped" on tts_stop) with the player used, so the frontend can pace
/// sentence-by-sentence highlighting. "xdg-open" exits immediately and
/// cannot be paced.
#[tauri::command]
pub fn tts_play(app: AppHandle, mp3: String, on_result: Channel<Cmd<String>>) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<TtsState>();
        let out = match play_inner(std::path::Path::new(&mp3), &state).await {
            Ok(player) => Cmd::ok(player),
            Err(e) => Cmd::err(e),
        };
        let _ = on_result.send(out);
    });
}

/// Accept only `[+-]<digits><suffix>` — these strings become argv values, and
/// the joined `--opt=value` form keeps a leading `-` out of flag position.
fn valid_tts_param(s: &str, suffix: &str) -> bool {
    let num = s.strip_suffix(suffix).unwrap_or("");
    let num = num
        .strip_prefix('+')
        .or_else(|| num.strip_prefix('-'))
        .unwrap_or(num);
    !num.is_empty() && num.chars().all(|c| c.is_ascii_digit())
}

/// Only files this app synthesized are playable — the path arrives over IPC.
fn is_app_synth(mp3: &std::path::Path) -> bool {
    mp3.parent().is_some_and(|d| d == std::env::temp_dir())
        && mp3
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("notepad-tts-"))
}

async fn synth_inner(
    text: &str,
    voice: Option<String>,
    rate: Option<String>,
    pitch: Option<String>,
    volume: Option<String>,
    state: &TtsState,
) -> Result<std::path::PathBuf, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("nothing to read".into());
    }
    // ponytail: hard cap — edge-tts degrades on very long single requests.
    let text = text.chars().take(30_000).collect::<String>();
    // No kill-on-new-request here: the prefetch pipeline keeps several synths
    // in flight and each owns a uniquely named mp3 — killing the previous one
    // used to make the prefetch pipeline self-terminate. tts_stop drains.
    cleanup_old_temp_files();

    let stamp = crate::fs::epoch_ms();
    let dir = std::env::temp_dir();
    // Exclusive + 0600: /tmp is world-writable, so a guessed name must not
    // follow a pre-planted symlink and document text must not be readable by
    // other local users. Retry with a fresh stamp on the (rare) name clash.
    let mut txt = None;
    let mut mp3 = None;
    for attempt in 0..5 {
        let s = stamp + attempt;
        let t = dir.join(format!("notepad-tts-{s}-{}.txt", std::process::id()));
        let m = dir.join(format!("notepad-tts-{s}-{}.mp3", std::process::id()));
        #[cfg(unix)]
        let open = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&t)
        };
        #[cfg(not(unix))]
        let open = std::fs::OpenOptions::new().write(true).create_new(true).open(&t);
        match open {
            Ok(mut f) => {
                use std::io::Write as _;
                f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                txt = Some(t);
                mp3 = Some(m);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    let Some(txt) = txt else {
        return Err("could not create a TTS temp file".into());
    };
    let mp3 = mp3.unwrap();

    let txt2 = txt.clone();
    let mp32 = mp3.clone();
    let voice = voice.unwrap_or_else(|| "en-US-AriaNeural".into());
    let mut cmd = tokio::process::Command::new(edge_tts_path());
    cmd.arg("--file")
        .arg(&txt2)
        .arg("--voice")
        .arg(&voice)
        .arg("--write-media")
        .arg(&mp32);
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

    let gen = next_gen();
    state
        .synth
        .lock()
        .map_err(|e| e.to_string())?
        .insert(gen, synth);

    // Poll for completion without holding the lock across .await, so
    // tts_stop can drain and kill children mid-synthesis. Only this task's
    // own generation is ours to poll or remove.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        {
            let mut s = state.synth.lock().map_err(|e| e.to_string())?;
            match s.get_mut(&gen) {
                // Drained by tts_stop (or a stop of this very request).
                None => {
                    let _ = std::fs::remove_file(&txt);
                    return Err("stopped".into());
                }
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        s.remove(&gen);
                        let _ = std::fs::remove_file(&txt);
                        if !status.success() {
                            return Err("speech synthesis failed".into());
                        }
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        s.remove(&gen);
                        let _ = std::fs::remove_file(&txt);
                        return Err(e.to_string());
                    }
                },
            }
        }
        if tokio::time::Instant::now() >= deadline {
            state
                .synth
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&gen);
            let _ = std::fs::remove_file(&txt);
            return Err("speech synthesis timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }

    // edge-tts writes the mp3 with default perms; tighten before it lingers
    // (up to an hour on the xdg-open path).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&mp3, std::fs::Permissions::from_mode(0o600));
    }
    Ok(mp3)
}

async fn play_inner(mp3: &std::path::Path, state: &TtsState) -> Result<String, String> {
    if !is_app_synth(mp3) || !mp3.is_file() {
        return Err("not a synthesized audio file".into());
    }
    // Pick a player: mpv → ffplay → xdg-open (default media app).
    let play = |prog: &str, args: &[&str]| -> Option<Child> {
        tokio::process::Command::new(prog)
            .args(args)
            .arg(mp3)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()
    };
    // A fresh play replaces any current one.
    if let Ok(mut p) = state.player.lock() {
        kill_locked(&mut p);
    }
    let player = play("mpv", &["--no-video", "--really-quiet"])
        .map(|c| (c, "mpv"))
        .or_else(|| {
            play(
                "ffplay",
                ["-nodisp", "-autoexit", "-loglevel", "quiet"].as_slice(),
            )
            .map(|c| (c, "ffplay"))
        })
        .or_else(|| play("xdg-open", &[]).map(|c| (c, "xdg-open")));
    match player {
        Some((child, name)) => {
            let gen = next_gen();
            *state.player.lock().map_err(|e| e.to_string())? = Some((gen, child));
            if name == "xdg-open" {
                // ponytail: the mp3 outlives playback here — xdg-open hands
                // the file to the desktop and exits, so deletion would race
                // the real player; the janitor sweeps it after an hour.
                return Ok(name.into()); // hands off and exits — nothing to wait for
            }
            // Wait for playback to end so the caller can pace sentence
            // highlighting. tts_stop empties the slot, which ends this wait.
            loop {
                {
                    let mut p = state.player.lock().map_err(|e| e.to_string())?;
                    match p.as_mut() {
                        None => return Err("stopped".into()),
                        // A newer play replaced ours — stop pacing the old one.
                        Some((g, _)) if *g != gen => return Err("stopped".into()),
                        Some((_, c)) => match c.try_wait() {
                            Ok(Some(_)) => {
                                *p = None;
                                let _ = std::fs::remove_file(mp3);
                                return Ok(name.into());
                            }
                            Ok(None) => {}
                            Err(e) => {
                                *p = None;
                                let _ = std::fs::remove_file(mp3);
                                return Err(e.to_string());
                            }
                        },
                    }
                }
                // Fast poll: this is dead air between sentences — mpv exits
                // right after the last sample, so every ms here is silence.
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }
        None => {
            let _ = std::fs::remove_file(mp3);
            Err("no audio player found (install mpv or ffplay)".into())
        }
    }
}

/// Remove notepad-tts temp files older than an hour. Document text used to
/// sit in /tmp forever.
pub(crate) fn cleanup_old_temp_files() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
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
    use super::{edge_tts_candidates, is_app_synth, valid_tts_param};

    #[test]
    fn tts_candidates_include_pip_user_dir() {
        // The desktop-session PATH omits ~/.local/bin; the pip fallback must
        // always be in the search list or installed-app read-aloud breaks.
        let home = std::env::var_os("HOME").expect("HOME set in test env");
        let expected = std::path::PathBuf::from(home).join(".local/bin/edge-tts");
        assert!(edge_tts_candidates().contains(&expected));
    }

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

    #[test]
    fn tts_play_guard_only_accepts_app_synth_files() {
        let dir = std::env::temp_dir();
        assert!(is_app_synth(&dir.join("notepad-tts-123-456.mp3")));
        // Wrong location or wrong name: rejected.
        assert!(!is_app_synth(std::path::Path::new(
            "/etc/notepad-tts-123-456.mp3"
        )));
        assert!(!is_app_synth(&dir.join("passwd")));
        assert!(!is_app_synth(&dir.join("notepad-tts-evil/../../.bashrc")));
    }
}
