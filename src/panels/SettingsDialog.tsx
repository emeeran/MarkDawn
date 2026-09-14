import { useEffect, useState } from 'react'
import { tauri } from '../lib/tauri'
import { useSettings } from '../stores/settings'
import type { ProviderId } from '../types'

const PROVIDERS: { id: ProviderId; label: string; needsKey: boolean }[] = [
  { id: 'anthropic', label: 'Anthropic', needsKey: true },
  { id: 'openai', label: 'OpenAI', needsKey: true },
  { id: 'groq', label: 'Groq', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', needsKey: false },
]

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useSettings()
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [modelList, setModelList] = useState<string[]>([])
  const [voiceList, setVoiceList] = useState<string[]>([])
  const [ttsOk, setTtsOk] = useState<boolean | null>(null)

  useEffect(() => {
    void tauri.secretStatus().then(setKeyStatus)
    void tauri.ttsAvailable().then(setTtsOk)
  }, [])

  async function saveKey(p: ProviderId) {
    const key = keyDraft[p]?.trim()
    if (!key) return
    await tauri.secretSet(p, key)
    setKeyDraft((d) => ({ ...d, [p]: '' }))
    setKeyStatus(await tauri.secretStatus())
  }

  async function removeKey(p: ProviderId) {
    await tauri.secretDelete(p)
    setKeyStatus(await tauri.secretStatus())
  }

  async function fetchModels() {
    try {
      setModelList(await tauri.fetchModels(settings.provider, settings.ollamaUrl))
    } catch (e) {
      setModelList([])
      alert(String(e))
    }
  }

  async function fetchVoices() {
    try {
      setVoiceList(await tauri.ttsVoices())
    } catch (e) {
      setVoiceList([])
      alert(String(e))
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Preferences</h2>

        <h3>Appearance</h3>
        <div className="settings-row">
          <label>Theme</label>
          <select value={settings.theme} onChange={(e) => settings.set('theme', e.target.value as typeof settings.theme)}>
            <option value="github">GitHub</option>
            <option value="night">Night</option>
            <option value="newsprint">Newsprint</option>
            <option value="pixyll">Pixyll</option>
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
                .catch((e) => alert(`Read aloud: ${e}`))
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
          <button onClick={() => void fetchModels()}>Fetch models</button>
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
