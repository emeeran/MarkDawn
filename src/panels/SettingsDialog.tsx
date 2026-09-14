import { useEffect, useState } from 'react'
import { tauri } from '../lib/tauri'
import { useSettings } from '../stores/settings'
import { useToast } from '../stores/toast'
import type { ProviderId, ThemeId } from '../types'

const PROVIDERS: { id: ProviderId; label: string; needsKey: boolean }[] = [
  { id: 'anthropic', label: 'Anthropic', needsKey: true },
  { id: 'openai', label: 'OpenAI', needsKey: true },
  { id: 'groq', label: 'Groq', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', needsKey: false },
]

const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'auto', label: 'Auto (light/dark)' },
  { id: 'github', label: 'GitHub' },
  { id: 'night', label: 'Night' },
  { id: 'newsprint', label: 'Newsprint' },
  { id: 'pixyll', label: 'Pixyll' },
]

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useSettings()
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [modelList, setModelList] = useState<string[]>([])
  const [voiceList, setVoiceList] = useState<string[]>([])
  const [ttsOk, setTtsOk] = useState<boolean | null>(null)
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    // A locked keychain must not silently no-op; surface the failure.
    tauri.secretStatus().then(setKeyStatus).catch((e) => useToast.getState().show(`Keychain: ${e}`))
    void tauri.ttsAvailable().then(setTtsOk)
  }, [])

  async function saveKey(p: ProviderId) {
    const key = keyDraft[p]?.trim()
    if (!key) return
    try {
      await tauri.secretSet(p, key)
      setKeyDraft((d) => ({ ...d, [p]: '' }))
      setKeyStatus(await tauri.secretStatus())
    } catch (e) {
      useToast.getState().show(`Saving key: ${e}`)
    }
  }

  async function removeKey(p: ProviderId) {
    try {
      await tauri.secretDelete(p)
      setKeyStatus(await tauri.secretStatus())
    } catch (e) {
      useToast.getState().show(`Removing key: ${e}`)
    }
  }

  async function fetchModels() {
    setFetching(true)
    try {
      setModelList(await tauri.fetchModels(settings.provider, settings.ollamaUrl))
    } catch (e) {
      setModelList([])
      useToast.getState().show(`Fetch models: ${e}`)
    } finally {
      setFetching(false)
    }
  }

  async function fetchVoices() {
    try {
      setVoiceList(await tauri.ttsVoices())
    } catch (e) {
      setVoiceList([])
      useToast.getState().show(`Fetch voices: ${e}`)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Preferences</h2>

        <h3>Appearance</h3>
        <div className="settings-row">
          <label>Theme</label>
          <select value={settings.theme} onChange={(e) => settings.set('theme', e.target.value as ThemeId)}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <label>Font size</label>
          <input
            type="range" min={12} max={24} value={settings.fontSize}
            onChange={(e) => settings.set('fontSize', Number(e.target.value))}
          />
          <span>{settings.fontSize}px</span>
        </div>

        <h3>Layout</h3>
        <div className="settings-col">
          <label>
            <input type="checkbox" checked={settings.showWordCount} onChange={(e) => settings.set('showWordCount', e.target.checked)} />
            Show word count
          </label>
          <div className="settings-row">
            <label>Sidebar width</label>
            <input
              type="range" min={160} max={480} value={settings.sidebarWidth}
              onChange={(e) => settings.set('sidebarWidth', Number(e.target.value))}
            />
            <span>{settings.sidebarWidth}px</span>
            <button onClick={() => settings.set('sidebarWidth', 240)}>Reset</button>
          </div>
          <small>Drag the sidebar edge to resize · double-click it (or ⌘⇧L) to fold.</small>
        </div>

        <h3>Editor</h3>
        <div className="settings-col">
          <label><input type="checkbox" checked={settings.focusMode} onChange={(e) => settings.set('focusMode', e.target.checked)} /> Focus mode</label>
          <label><input type="checkbox" checked={settings.typewriterMode} onChange={(e) => settings.set('typewriterMode', e.target.checked)} /> Typewriter mode</label>
          <label>
            <input type="checkbox" checked={settings.ghostText} onChange={(e) => settings.set('ghostText', e.target.checked)} />
            Ghost text autocomplete <small>(sends text to the configured provider while typing)</small>
          </label>
        </div>

        <h3>Read Aloud <small>{ttsOk === null ? '' : ttsOk ? '· edge-tts detected' : '· edge-tts not found (pip install edge-tts)'}</small></h3>
        <div className="settings-row">
          <label>Voice</label>
          <input
            list="tts-voices"
            value={settings.ttsVoice}
            onChange={(e) => settings.set('ttsVoice', e.target.value)}
          />
          <datalist id="tts-voices">
            {voiceList.map((v) => <option key={v} value={v} />)}
          </datalist>
          <button onClick={() => void fetchVoices()}>Fetch voices</button>
          <button
            onClick={() =>
              void tauri
                .ttsSpeak('Read aloud is ready.', settings.ttsVoice || undefined)
                .catch((e) => useToast.getState().show(`Read aloud: ${e}`))
            }
            disabled={ttsOk === false}
            title="Speak a sample line with the configured voice"
          >
            Test
          </button>
        </div>

        <h3>AI</h3>
        <div className="settings-row">
          <label>Provider</label>
          <select value={settings.provider} onChange={(e) => settings.set('provider', e.target.value as ProviderId)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <label>Model</label>
          <input
            list={`models-${settings.provider}`}
            value={settings.models[settings.provider]}
            onChange={(e) => settings.set('models', { ...settings.models, [settings.provider]: e.target.value })}
          />
          <datalist id={`models-${settings.provider}`}>
            {modelList.map((m) => <option key={m} value={m} />)}
          </datalist>
          <button onClick={() => void fetchModels()} disabled={fetching}>
            {fetching ? 'Fetching…' : 'Fetch models'}
          </button>
        </div>
        {settings.provider === 'ollama' && (
          <div className="settings-row">
            <label>Server</label>
            <input value={settings.ollamaUrl} onChange={(e) => settings.set('ollamaUrl', e.target.value)} />
          </div>
        )}

        <h3>API keys <small>(stored in the OS keychain only)</small></h3>
        {PROVIDERS.filter((p) => p.needsKey).map((p) => (
          <div className="settings-row" key={p.id}>
            <label>
              {p.label} <span className={keyStatus[p.id] ? 'key-ok' : 'key-missing'}>{keyStatus[p.id] ? '✓ set' : 'not set'}</span>
            </label>
            <input
              type="password"
              autoComplete="new-password"
              placeholder={keyStatus[p.id] ? '••••••••' : 'paste API key'}
              value={keyDraft[p.id] ?? ''}
              onChange={(e) => setKeyDraft((d) => ({ ...d, [p.id]: e.target.value }))}
            />
            <button onClick={() => void saveKey(p.id)}>Save</button>
            {keyStatus[p.id] && <button onClick={() => void removeKey(p.id)}>Remove</button>}
          </div>
        ))}

        <div className="modal-footer">
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
