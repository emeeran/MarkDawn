use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;

use crate::secrets;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}

#[derive(Deserialize)]
pub struct AiMessage {
    pub role: String, // "user" | "assistant" | "system"
    pub content: String,
}

#[derive(Deserialize)]
pub struct AiRequest {
    provider: String, // anthropic | openai | groq | ollama
    model: String,
    #[serde(default)]
    system: String,
    messages: Vec<AiMessage>,
    /// Max chars of any single completion; hard safety stop, not a billing control.
    #[serde(default = "default_max_chars")]
    max_chars: usize,
    /// Ollama server URL override.
    #[serde(default = "default_ollama_url")]
    ollama_url: String,
}

fn default_max_chars() -> usize {
    16_000
}
fn default_ollama_url() -> String {
    "http://localhost:11434".into()
}

/// Registry of in-flight streams so the webview can cancel them.
/// `active` maps stream id → task handle; `cancelled` records cancel requests
/// that arrived before the task was registered (spawn/insert race).
#[derive(Default)]
pub struct Streams {
    active: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
}

/// Managed-state constructor.
pub fn streams() -> Streams {
    Streams::default()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

/// Only loopback and private/LAN hosts may be used as the Ollama base URL.
/// The URL comes from the webview; without this it is an SSRF/exfil channel
/// to arbitrary internet hosts. ponytail: private-range allowlist, not a
/// general proxy policy — widen if someone legitimately runs Ollama behind a
/// public hostname.
fn validate_ollama_url(url: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|_| format!("invalid Ollama URL: {url}"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("Ollama URL must be http(s)".into());
    }
    let host = u.host_str().unwrap_or_default().to_lowercase();
    let ok = host == "localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
        || host.starts_with("[::1]")
        // 172.16.0.0 – 172.31.255.255
        || host
            .strip_prefix("172.")
            .and_then(|r| r.split('.').next())
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| (16..=31).contains(&n));
    if ok {
        Ok(u)
    } else {
        Err(format!("Ollama URL host must be local or private: {host}"))
    }
}

/// Stream one AI completion to the webview over a Tauri Channel.
/// Runs entirely in Rust so API keys never cross the IPC boundary.
#[tauri::command]
pub fn ai_stream(
    id: String,
    req: AiRequest,
    on_event: Channel<AiEvent>,
    streams: State<'_, Streams>,
) -> Result<(), String> {
    let active = streams.active.clone();
    let cancelled = streams.cancelled.clone();
    let task_id = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(e) = stream(&req, &on_event).await {
            let _ = on_event.send(AiEvent::Error { message: e });
        }
        let _ = on_event.send(AiEvent::Done);
        // Natural completion: release the entry (it used to leak per session).
        if let Ok(mut a) = active.lock() {
            a.remove(&task_id);
        }
        if let Ok(mut c) = cancelled.lock() {
            c.remove(&task_id);
        }
    });
    {
        let was_cancelled = streams
            .cancelled
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&id);
        let mut active = streams.active.lock().map_err(|e| e.to_string())?;
        if was_cancelled {
            // Cancel arrived between spawn and registration.
            handle.abort();
        } else {
            active.insert(id, handle);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(id: String, streams: State<'_, Streams>) {
    if let Ok(mut c) = streams.cancelled.lock() {
        c.insert(id.clone());
    }
    if let Ok(mut a) = streams.active.lock() {
        if let Some(h) = a.remove(&id) {
            h.abort();
        }
    }
}

const DEFAULT_OLLAMA: &str = "http://localhost:11434";

async fn ollama_tags(base: &str) -> Result<Vec<String>, String> {
    let base = validate_ollama_url(base)?;
    let url = format!("{}://{}{}/api/tags", base.scheme(), base.host_str().unwrap_or_default(), base.port_or_known_default().map(|p| format!(":{p}")).unwrap_or_default());
    let resp = client()?
        .get(&url)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|_| format!("cannot reach Ollama at {base}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json["models"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

/// Model listing via Channel — async-command responses don't resolve on this
/// WebKitGTK build, so sync command + spawned task + Channel.
#[tauri::command]
pub fn ollama_models(ollama_url: Option<String>, on_result: Channel<crate::pick::Cmd<Vec<String>>>) {
    tauri::async_runtime::spawn(async move {
        let out = match ollama_tags(ollama_url.as_deref().unwrap_or(DEFAULT_OLLAMA)).await {
            Ok(v) => crate::pick::Cmd { ok: true, value: v, error: None },
            Err(e) => crate::pick::Cmd { ok: false, value: Vec::new(), error: Some(e) },
        };
        let _ = on_result.send(out);
    });
}

/// List available models for a provider, powering the Settings model selector.
#[tauri::command]
pub fn fetch_models(
    provider: String,
    ollama_url: Option<String>,
    on_result: Channel<crate::pick::Cmd<Vec<String>>>,
) {
    tauri::async_runtime::spawn(async move {
        let out = match list_models(provider, ollama_url).await {
            Ok(v) => crate::pick::Cmd { ok: true, value: v, error: None },
            Err(e) => crate::pick::Cmd { ok: false, value: Vec::new(), error: Some(e) },
        };
        let _ = on_result.send(out);
    });
}

async fn list_models(provider: String, ollama_url: Option<String>) -> Result<Vec<String>, String> {
    match provider.as_str() {
        "ollama" => {
            ollama_tags(ollama_url.as_deref().unwrap_or(DEFAULT_OLLAMA)).await
        }
        // OpenAI-compatible {data: [{id}]} shape.
        "openai" => list_bearer_models("https://api.openai.com/v1/models", "openai").await,
        "groq" => list_bearer_models("https://api.groq.com/openai/v1/models", "groq").await,
        "anthropic" => {
            let key = secrets::read_key("anthropic")?;
            let resp = client()?
                .get("https://api.anthropic.com/v1/models")
                .header("x-api-key", &key)
                .header("anthropic-version", "2023-06-01")
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("HTTP {status}: {}", truncate(&body, 300)));
            }
            let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            Ok(json["data"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m["id"].as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default())
        }
        other => Err(format!("unknown provider: {other}")),
    }
}

async fn list_bearer_models(url: &str, provider: &str) -> Result<Vec<String>, String> {
    let key = secrets::read_key(provider)?;
    let resp = client()?
        .get(url)
        .header("Authorization", format!("Bearer {key}"))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", truncate(&body, 300)));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str())
                .filter(|id| is_chat_model(id))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default())
}

/// Exclude known non-chat model families (classifiers, transcription,
/// TTS, embeddings) — they break a streaming chat request.
/// Keep in sync with NON_CHAT_MODEL in src/stores/settings.ts.
fn is_chat_model(id: &str) -> bool {
    let l = id.to_lowercase();
    !["guard", "whisper", "tts", "embed", "rerank", "safety", "dall-e"]
        .iter()
        .any(|k| l.contains(k))
}

async fn stream(req: &AiRequest, ch: &Channel<AiEvent>) -> Result<(), String> {
    match req.provider.as_str() {
        "anthropic" => stream_anthropic(req, ch).await,
        "openai" => {
            stream_openai_compatible(
                "https://api.openai.com/v1/chat/completions",
                "openai",
                req,
                ch,
            ).await
        }
        // Groq speaks the OpenAI chat-completions protocol.
        "groq" => {
            stream_openai_compatible(
                "https://api.groq.com/openai/v1/chat/completions",
                "groq",
                req,
                ch,
            ).await
        }
        "ollama" => stream_ollama(req, ch).await,
        other => Err(format!("unknown provider: {other}")),
    }
}

fn emit(ch: &Channel<AiEvent>, text: &str, sent: &mut usize, max: usize) -> Result<(), String> {
    *sent += text.len();
    if *sent > max {
        return Err("completion exceeded length limit".into());
    }
    let _ = ch.send(AiEvent::Delta { text: text.to_string() });
    Ok(())
}

async fn post_stream(
    builder: reqwest::RequestBuilder,
    provider: &str,
) -> Result<reqwest::Response, String> {
    let resp = builder.timeout(Duration::from_secs(600)).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let mut msg = extract_api_error(&body);
        // Model advice is only meaningful for the provider it names.
        if provider == "groq" && msg.contains("do not support streaming") {
            msg.push_str(" — this model can't stream. Pick a chat model in Preferences → AI (e.g. llama-3.3-70b-versatile).");
        }
        return Err(format!("HTTP {status}: {msg}"));
    }
    Ok(resp)
}

/// Pull the human-readable message out of an API error body
/// ({"error":{"message":"…"}} shape used by Anthropic/OpenAI/Groq).
fn extract_api_error(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = v["error"]["message"].as_str() {
            return truncate(m, 300).to_string();
        }
    }
    truncate(body, 300).to_string()
}

// --- stream decoding -------------------------------------------------------
//
// Network chunks have no respect for UTF-8 character boundaries (a 4-byte
// emoji can straddle two chunks) or line boundaries. `Utf8Lines` buffers raw
// bytes and only decodes complete lines, so multi-byte characters survive.

/// Byte buffer that hands out complete lines, decoded boundary-safely.
struct Utf8Lines {
    buf: Vec<u8>,
}

impl Utf8Lines {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Next complete line (without the trailing newline), or None if the
    /// buffer holds no newline yet. A finished line is always a valid char
    /// boundary (the newline is ASCII), so decoding the whole line is safe
    /// even when the *next* character is split mid-sequence.
    fn next_line(&mut self) -> Option<String> {
        let pos = self.buf.iter().position(|&b| b == b'\n')?;
        let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
        line.pop(); // drop the newline
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        Some(String::from_utf8_lossy(&line).into_owned())
    }
}

/// What one streamed line means, provider-independent.
#[derive(Debug, PartialEq)]
enum LineOut {
    Nothing,
    Delta(String),
    Stop,
    Error(String),
}

fn parse_anthropic_line(line: &str) -> LineOut {
    let Some(payload) = line.trim().strip_prefix("data:") else { return LineOut::Nothing };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload.trim()) else { return LineOut::Nothing };
    match v["type"].as_str() {
        Some("content_block_delta") => match v["delta"]["text"].as_str() {
            Some(t) if !t.is_empty() => LineOut::Delta(t.into()),
            _ => LineOut::Nothing,
        },
        Some("error") => LineOut::Error(v["error"]["message"].as_str().unwrap_or("stream error").into()),
        Some("message_stop") => LineOut::Stop,
        _ => LineOut::Nothing,
    }
}

fn parse_openai_line(line: &str) -> LineOut {
    let Some(payload) = line.trim().strip_prefix("data:") else { return LineOut::Nothing };
    let payload = payload.trim();
    if payload == "[DONE]" {
        return LineOut::Stop;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else { return LineOut::Nothing };
    match v["choices"][0]["delta"]["content"].as_str() {
        Some(t) if !t.is_empty() => LineOut::Delta(t.into()),
        _ => LineOut::Nothing,
    }
}

fn parse_ollama_line(line: &str) -> LineOut {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return LineOut::Nothing };
    if let Some(e) = v["error"].as_str() {
        return LineOut::Error(e.into());
    }
    if let Some(t) = v["message"]["content"].as_str() {
        if !t.is_empty() {
            return LineOut::Delta(t.into());
        }
    }
    if v["done"].as_bool() == Some(true) {
        return LineOut::Stop;
    }
    LineOut::Nothing
}

/// Shared pump: read byte chunks, split into lines, hand each to the
/// provider parser, emit deltas until a Stop or Error.
async fn pump_lines<F>(resp: reqwest::Response, ch: &Channel<AiEvent>, max: usize, parse: F) -> Result<(), String>
where
    F: Fn(&str) -> LineOut,
{
    let mut stream = resp.bytes_stream();
    let mut lines = Utf8Lines::new();
    let mut sent = 0usize;
    while let Some(chunk) = stream.next().await {
        lines.push(&chunk.map_err(|e| e.to_string())?);
        while let Some(line) = lines.next_line() {
            match parse(&line) {
                LineOut::Nothing => {}
                LineOut::Delta(t) => emit(ch, &t, &mut sent, max)?,
                LineOut::Stop => return Ok(()),
                LineOut::Error(e) => return Err(e),
            }
        }
    }
    Ok(())
}

async fn stream_anthropic(req: &AiRequest, ch: &Channel<AiEvent>) -> Result<(), String> {
    let key = secrets::read_key("anthropic")?;
    let url = "https://api.anthropic.com/v1/messages";
    let body = serde_json::json!({
        "model": req.model,
        "max_tokens": 8192,
        "stream": true,
        "system": req.system,
        "messages": req.messages.iter()
            .filter(|m| m.role != "system")
            .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
            .collect::<Vec<_>>(),
    });
    let resp = post_stream(
        client()?.post(url)
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .json(&body),
        "anthropic",
    ).await?;
    pump_lines(resp, ch, req.max_chars, parse_anthropic_line).await
}

/// OpenAI chat-completions protocol (OpenAI, Groq, and other compatible hosts).
async fn stream_openai_compatible(
    url: &str,
    provider: &str,
    req: &AiRequest,
    ch: &Channel<AiEvent>,
) -> Result<(), String> {
    let key = secrets::read_key(provider)?;
    let body = serde_json::json!({
        "model": req.model,
        "stream": true,
        "messages": chat_messages(&req.system, &req.messages),
    });
    let resp = post_stream(
        client()?.post(url).header("Authorization", format!("Bearer {key}")).json(&body),
        provider,
    ).await?;
    pump_lines(resp, ch, req.max_chars, parse_openai_line).await
}

async fn stream_ollama(req: &AiRequest, ch: &Channel<AiEvent>) -> Result<(), String> {
    let base = validate_ollama_url(&req.ollama_url)?;
    let url = format!("{}://{}{}/api/chat", base.scheme(), base.host_str().unwrap_or_default(), base.port_or_known_default().map(|p| format!(":{p}")).unwrap_or_default());
    let body = serde_json::json!({
        "model": req.model,
        "stream": true,
        "messages": chat_messages(&req.system, &req.messages),
    });
    let resp = post_stream(client()?.post(&url).json(&body), "ollama").await?;
    // Ollama streams NDJSON, not SSE.
    pump_lines(resp, ch, req.max_chars, parse_ollama_line).await
}

fn chat_messages(system: &str, messages: &[AiMessage]) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    if !system.is_empty() {
        out.push(serde_json::json!({"role": "system", "content": system}));
    }
    for m in messages {
        if m.role != "system" {
            out.push(serde_json::json!({"role": m.role, "content": m.content}));
        }
    }
    out
}

fn truncate(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_api_error_pulls_message_field() {
        let body = r#"{"error":{"message":"text classification models do not support streaming","type":"invalid_request_error"}}"#;
        assert_eq!(extract_api_error(body), "text classification models do not support streaming");
    }

    #[test]
    fn extract_api_error_falls_back_to_raw_body() {
        assert_eq!(extract_api_error("not json"), "not json");
    }

    #[test]
    fn is_chat_model_excludes_non_chat_families() {
        assert!(is_chat_model("llama-3.3-70b-versatile"));
        assert!(is_chat_model("gpt-5.2"));
        assert!(!is_chat_model("meta-llama/llama-prompt-guard-2-22m"));
        assert!(!is_chat_model("whisper-large-v3"));
        assert!(!is_chat_model("playai-tts"));
        assert!(!is_chat_model("gpt-5.2-dall-e-3"));
    }

    #[test]
    fn utf8_lines_keeps_multibyte_chars_across_chunks() {
        let mut l = Utf8Lines::new();
        // 🌍 is 4 bytes; split it across two pushes.
        let full = "hello 🌍\n".as_bytes();
        let (a, b) = full.split_at(full.len() - 3);
        l.push(a);
        assert_eq!(l.next_line(), None);
        l.push(b);
        assert_eq!(l.next_line().as_deref(), Some("hello 🌍"));
        assert_eq!(l.next_line(), None);
    }

    #[test]
    fn utf8_lines_handles_crlf_and_multiple_lines() {
        let mut l = Utf8Lines::new();
        l.push(b"a\r\nbb\r");
        assert_eq!(l.next_line().as_deref(), Some("a"));
        l.push(b"\nccc");
        assert_eq!(l.next_line().as_deref(), Some("bb"));
        assert_eq!(l.next_line(), None);
        l.push(b"\n");
        assert_eq!(l.next_line().as_deref(), Some("ccc"));
    }

    #[test]
    fn anthropic_parser_reads_deltas_stop_and_error() {
        assert_eq!(
            parse_anthropic_line("data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}"),
            LineOut::Delta("hi".into())
        );
        assert_eq!(parse_anthropic_line("data: {\"type\":\"message_stop\"}"), LineOut::Stop);
        assert_eq!(
            parse_anthropic_line("data: {\"type\":\"error\",\"error\":{\"message\":\"boom\"}}"),
            LineOut::Error("boom".into())
        );
        assert_eq!(parse_anthropic_line("event: ping"), LineOut::Nothing);
    }

    #[test]
    fn openai_parser_reads_done_and_deltas() {
        assert_eq!(parse_openai_line("data: [DONE]"), LineOut::Stop);
        assert_eq!(
            parse_openai_line("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}"),
            LineOut::Delta("x".into())
        );
        // Split JSON across two lines must not panic — first half parses as Nothing.
        assert_eq!(parse_openai_line("data: {\"choices\":["), LineOut::Nothing);
    }

    #[test]
    fn ollama_parser_reads_ndjson_done_and_error() {
        assert_eq!(
            parse_ollama_line("{\"message\":{\"content\":\"yo\"},\"done\":false}"),
            LineOut::Delta("yo".into())
        );
        assert_eq!(parse_ollama_line("{\"message\":{\"content\":\"\"},\"done\":true}"), LineOut::Stop);
        assert_eq!(parse_ollama_line("{\"error\":\"model missing\"}"), LineOut::Error("model missing".into()));
    }

    #[test]
    fn ollama_url_allows_private_and_rejects_public() {
        assert!(validate_ollama_url("http://localhost:11434").is_ok());
        assert!(validate_ollama_url("http://127.0.0.1:11434").is_ok());
        assert!(validate_ollama_url("http://192.168.1.20:11434").is_ok());
        assert!(validate_ollama_url("http://10.0.0.5").is_ok());
        assert!(validate_ollama_url("http://172.16.5.5:11434").is_ok());
        assert!(validate_ollama_url("http://172.32.5.5:11434").is_err()); // public 172.x
        assert!(validate_ollama_url("https://example.com/api").is_err());
        assert!(validate_ollama_url("https://evil.example.com").is_err());
        assert!(validate_ollama_url("ftp://localhost").is_err());
        assert!(validate_ollama_url("not a url").is_err());
    }

    #[test]
    fn chat_messages_prepends_system_and_skips_system_role() {
        let msgs = vec![
            AiMessage { role: "system".into(), content: "sneaky".into() },
            AiMessage { role: "user".into(), content: "q".into() },
            AiMessage { role: "assistant".into(), content: "a".into() },
        ];
        let out = chat_messages("sys", &msgs);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out[0]["content"], "sys");
        assert_eq!(out[1]["role"], "user");
    }
}
