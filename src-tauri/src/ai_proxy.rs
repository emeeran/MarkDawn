use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
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
    provider: String, // anthropic | openai | ollama
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

/// Handle type from tauri::async_runtime::spawn; supports abort().
pub type AbortMap = Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>;

/// Managed-state constructor.
pub fn abort_map() -> AbortMap {
    Mutex::new(HashMap::new())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

/// Stream one AI completion to the webview over a Tauri Channel.
/// Runs entirely in Rust so API keys never cross the IPC boundary.
#[tauri::command]
pub fn ai_stream(
    id: String,
    req: AiRequest,
    on_event: Channel<AiEvent>,
    aborts: State<'_, AbortMap>,
) -> Result<(), String> {
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(e) = stream(&req, &on_event).await {
            let _ = on_event.send(AiEvent::Error { message: e });
        }
        let _ = on_event.send(AiEvent::Done);
    });
    aborts
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, handle);
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(id: String, aborts: State<'_, AbortMap>) {
    if let Ok(mut map) = aborts.lock() {
        if let Some(h) = map.remove(&id) {
            h.abort();
        }
    }
}

#[tauri::command]
pub async fn ollama_models(ollama_url: Option<String>) -> Result<Vec<String>, String> {
    let base = ollama_url.unwrap_or_else(default_ollama_url);
    let url = format!("{base}/api/tags");
    let resp = client()?
        .get(&url)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|_| format!("cannot reach Ollama at {base}"))?;
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

async fn stream(req: &AiRequest, ch: &Channel<AiEvent>) -> Result<(), String> {
    match req.provider.as_str() {
        "anthropic" => stream_anthropic(req, ch).await,
        "openai" => stream_openai(req, ch).await,
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

async fn post_stream(builder: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let resp = builder.timeout(Duration::from_secs(600)).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", truncate(&body, 500)));
    }
    Ok(resp)
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
    ).await?;

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut sent = 0usize;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            if let Some(payload) = line.trim().strip_prefix("data:") {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(payload.trim()) else { continue };
                match v["type"].as_str() {
                    Some("content_block_delta") => {
                        let t = v["delta"]["text"].as_str().unwrap_or_default();
                        if !t.is_empty() {
                            emit(ch, t, &mut sent, req.max_chars)?;
                        }
                    }
                    Some("error") => {
                        return Err(v["error"]["message"].as_str().unwrap_or("stream error").into())
                    }
                    Some("message_stop") => return Ok(()),
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

async fn stream_openai(req: &AiRequest, ch: &Channel<AiEvent>) -> Result<(), String> {
    let key = secrets::read_key("openai")?;
    let url = "https://api.openai.com/v1/chat/completions";
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if !req.system.is_empty() {
        messages.push(serde_json::json!({"role": "system", "content": req.system}));
    }
    for m in &req.messages {
        if m.role != "system" {
            messages.push(serde_json::json!({"role": m.role, "content": m.content}));
        }
    }
    let body = serde_json::json!({ "model": req.model, "stream": true, "messages": messages });
    let resp = post_stream(
        client()?.post(url).header("Authorization", format!("Bearer {key}")).json(&body),
    ).await?;

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut sent = 0usize;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let Some(payload) = line.trim().strip_prefix("data:") else { continue };
            let payload = payload.trim();
            if payload == "[DONE]" {
                return Ok(());
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else { continue };
            let t = v["choices"][0]["delta"]["content"].as_str().unwrap_or_default();
            if !t.is_empty() {
                emit(ch, t, &mut sent, req.max_chars)?;
            }
        }
    }
    Ok(())
}

async fn stream_ollama(req: &AiRequest, ch: &Channel<AiEvent>) -> Result<(), String> {
    let url = format!("{}/api/chat", req.ollama_url.trim_end_matches('/'));
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if !req.system.is_empty() {
        messages.push(serde_json::json!({"role": "system", "content": req.system}));
    }
    for m in &req.messages {
        if m.role != "system" {
            messages.push(serde_json::json!({"role": m.role, "content": m.content}));
        }
    }
    let body = serde_json::json!({ "model": req.model, "stream": true, "messages": messages });
    let resp = post_stream(client()?.post(&url).json(&body)).await?;

    // Ollama streams NDJSON, not SSE.
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut sent = 0usize;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
            if v["error"].as_str().is_some() {
                return Err(v["error"].as_str().unwrap().into());
            }
            let t = v["message"]["content"].as_str().unwrap_or_default();
            if !t.is_empty() {
                emit(ch, t, &mut sent, req.max_chars)?;
            }
            if v["done"].as_bool() == Some(true) {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn truncate(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}
