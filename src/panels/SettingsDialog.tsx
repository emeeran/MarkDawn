import { useEffect, useState } from 'react'
import { tauri } from '../lib/tauri'
import { useSettings } from '../stores/settings'
import { useToast } from '../stores/toast'
import type { ProviderId, TextAlignment } from '../types'

const PROVIDERS: { id: ProviderId; label: string; needsKey: boolean }[] = [
  { id: 'anthropic', label: 'Anthropic', needsKey: true },
  { id: 'openai', label: 'OpenAI', needsKey: true },
  { id: 'groq', label: 'Groq', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', needsKey: false },
]

const ALIGNMENTS: { id: TextAlignment; label: string; glyph: string }[] = [
  { id: 'left', label: 'Left', glyph: '⯇' },
  { id: 'center', label: 'Center', glyph: '≡' },
  { id: 'right', label: 'Right', glyph: '⯈' },
  { id: 'justify', label: 'Justify', glyph: '▤' },
]

// Suggestions only — any installed font name works.
const FONT_SUGGESTIONS = [
  'system-ui', 'Georgia', 'Palatino', 'Iowan Old Style', 'Charter', 'Merriweather',
  'Inter', 'Segoe UI', 'SF Pro Text', 'Literata', 'Newsreader', 'JetBrains Mono',
]

/**
 * Voices whose names mark them as the newest/most natural generations first
 * (Azure "Dragon HD", "Multilingual"), then plain alphabetical.
 */
function naturalFirst(voices: string[]): string[] {
  const score = (v: string) =>
    (/dragon|hd|multilingual/i.test(v) ? 0 : /neural/.test(v) ? 1 : 2)
  return [...voices].sort((a, b) => score(a) - score(b) || a.localeCompare(b))
}

function signed(value: number, unit: string): string {
  return `${value >= 0 ? '+' : ''}${value}${unit}`
}

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
    void fetchVoices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setVoiceList(naturalFirst(await tauri.ttsVoices()))
    } catch (e) {
      setVoiceList([])
      useToast.getState().show(`Fetch voices: ${e}`)
    }
  }

  function previewVoice() {
    void tauri
      .ttsSpeak(
        'Read aloud is ready. This is how your voice settings sound.',
        settings.ttsVoice || undefined,
        settings.ttsRate,
        settings.ttsPitch,
        settings.ttsVolume,
      )
      .catch((e) => useToast.getState().show(`Read aloud: ${e}`))
  }

  const pct = (v: string) => Number(v.replace(/[+%]/g, '')) || 0

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Preferences</h2>

        <h3>Fonts</h3>
        <div className="settings-col">
          <div className="settings-row">
            <label>Font</label>
            <input
              list="font-suggestions"
              placeholder="App default"
              value={settings.editorFont}
              onChange={(e) => settings.set('editorFont', e.target.value)}
            />
            <datalist id="font-suggestions">
              {FONT_SUGGESTIONS.map((f) => <option key={f} value={f} />)}
            </datalist>
          </div>
          <div className="settings-row">
            <label>Size</label>
            <input
              type="range" min={12} max={32} value={settings.fontSize}
              onChange={(e) => settings.set('fontSize', Number(e.target.value))}
            />
            <span>{settings.fontSize}px</span>
          </div>
          <div className="settings-row">
            <label>Line height</label>
            <input
              type="range" min={1.2} max={2.4} step={0.05} value={settings.lineHeight}
              onChange={(e) => settings.set('lineHeight', Number(e.target.value))}
            />
            <span>{settings.lineHeight.toFixed(2)}</span>
          </div>
          <div className="settings-row">
            <label>Paragraph alignment</label>
            <div className="seg-group" role="group">
              {ALIGNMENTS.map((a) => (
                <button
                  key={a.id}
                  title={a.label}
                  className={settings.textAlign === a.id ? 'on' : ''}
                  onClick={() => settings.set('textAlign', a.id)}
                >
                  {a.glyph}
                </button>
              ))}
            </div>
          </div>
          <small>Size also responds to ⌘+/⌘−/⌘0; themes live in the Themes menu.</small>
        </div>

        <h3>
          Read Aloud{' '}
          <small>
            {ttsOk === null ? '' : ttsOk ? `· ${voiceList.length || '…'} voices` : '· edge-tts not found (pip install edge-tts)'}
          </small>
        </h3>
        <div className="settings-col">
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
            <button onClick={() => void fetchVoices()} title="Refresh the voice list from edge-tts">
              Refresh
            </button>
          </div>
          {voiceList.length > 0 && (
            <small>
              Natural-first: Dragon HD / Multilingual voices are listed at the top
              ({voiceList.filter((v) => /dragon|hd|multilingual/i.test(v)).length} of {voiceList.length}).
            </small>
          )}
          <div className="settings-row">
            <label>Rate</label>
            <input
              type="range" min={-50} max={100} step={5} value={pct(settings.ttsRate)}
              onChange={(e) => settings.set('ttsRate', signed(Number(e.target.value), '%'))}
            />
            <span>{settings.ttsRate}</span>
          </div>
          <div className="settings-row">
            <label>Pitch</label>
            <input
              type="range" min={-50} max={50} step={5} value={pct(settings.ttsPitch)}
              onChange={(e) => settings.set('ttsPitch', signed(Number(e.target.value), 'Hz'))}
            />
            <span>{settings.ttsPitch}</span>
          </div>
          <div className="settings-row">
            <label>Volume</label>
            <input
              type="range" min={-100} max={100} step={5} value={pct(settings.ttsVolume)}
              onChange={(e) => settings.set('ttsVolume', signed(Number(e.target.value), '%'))}
            />
            <span>{settings.ttsVolume}</span>
          </div>
          <div className="settings-row">
            <button className="primary" onClick={previewVoice} disabled={ttsOk === false}>
              Test voice
            </button>
          </div>
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
