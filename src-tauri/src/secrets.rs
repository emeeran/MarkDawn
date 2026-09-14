use keyring::Entry;
use std::collections::BTreeMap;

const SERVICE: &str = "app.notepad.editor.ai";
const PROVIDERS: [&str; 3] = ["anthropic", "openai", "ollama"];

fn entry(provider: &str) -> Result<Entry, String> {
    if !PROVIDERS.contains(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

/// API keys live only in the OS keychain. The frontend can set/delete them and
/// ask whether one exists — it can never read the key back.
#[tauri::command]
pub fn secret_set(provider: String, key: String) -> Result<(), String> {
    entry(&provider)?.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_delete(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_status() -> Result<BTreeMap<String, bool>, String> {
    let mut map = BTreeMap::new();
    for p in PROVIDERS {
        let ok = entry(p)
            .and_then(|e| e.get_password().map(|_| ()).map_err(|e| e.to_string()))
            .is_ok();
        map.insert(p.to_string(), ok);
    }
    Ok(map)
}

/// Read a key for the Rust-side AI proxy. Not a tauri::command — never exposed.
pub(crate) fn read_key(provider: &str) -> Result<String, String> {
    let key = entry(provider)?.get_password().map_err(|e| e.to_string())?;
    if key.is_empty() {
        return Err("empty API key".into());
    }
    Ok(key)
}
