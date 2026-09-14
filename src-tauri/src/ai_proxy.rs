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

/// Model listing via Channel — async-command responses don't resolve on this
/// WebKitGTK build, so sync command + spawned task + Channel.
#[tauri::command]
pub fn ollama_models(ollama_url: Option<String>, on_result: Channel<crate::pick::Cmd<Vec<String>>>) {
    tauri::async_runtime::spawn(async move {
        let base = ollama_url.unwrap_or_else(default_ollama_url);
        let url = format!("{base}/api/tags");
        let out = (async {
            let resp = client()?
                .get(&url)
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .map_err(|_| format!("cannot reach Ollama at {base}"))?;
            let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            Ok::<Vec<String>, String>(json["models"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m["name"].as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default())
        })
        .await;
        let out = match out {
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

async fn post_stream(builder: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let resp = builder.timeout(Duration::from_secs(600)).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let mut msg = extract_api_error(&body);
        if msg.contains("do not support streaming") {
            msg.push_str(" — this model can't stream. Pick a chat model in Preferences → AI (e.g. llama-3.3-70b-versatile for Groq).");
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

/// OpenAI chat-completions protocol (OpenAI, Groq, and other compatible hosts).
async fn stream_openai_compatible(
    url: &str,
    provider: &str,
    req: &AiRequest,
    ch: &Channel<AiEvent>,
) -> Result<(), String> {
    let key = secrets::read_key(provider)?;
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
    }
}
