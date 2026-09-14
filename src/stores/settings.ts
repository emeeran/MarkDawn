import { create } from 'zustand'
import { tauri } from '../lib/tauri'
import { DEFAULT_SETTINGS, type Settings } from '../types'

interface SettingsStore extends Settings {
  loaded: boolean
  load: () => Promise<void>
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
}

let saveTimer: ReturnType<typeof setTimeout> | undefined

export const useSettings = create<SettingsStore>((setState, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  async load() {
    try {
      const stored = await tauri.settingsGet()
      const merged = { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) }
      // Migrate non-chat models that can't stream (e.g. Groq prompt-guard).
      for (const p of Object.keys(merged.models) as (keyof Settings['models'])[]) {
        if (/guard|whisper|tts|embed|rerank/i.test(merged.models[p])) {
          merged.models[p] = DEFAULT_SETTINGS.models[p]
        }
      }
      setState({ ...merged, loaded: true })
    } catch {
      setState({ loaded: true })
    }
  },
  set(key, value) {
    setState({ [key]: value } as Partial<SettingsStore>)
    // Debounced persistence; settings.json never holds API keys (keychain only).
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const s = get()
      const { loaded: _l, ...rest } = s
      void tauri.settingsSet(rest).catch(() => {})
    }, 300)
  },
}))
