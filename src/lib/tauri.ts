import { invoke, Channel, convertFileSrc } from '@tauri-apps/api/core'
import { open as pluginOpen, save as pluginSave } from '@tauri-apps/plugin-dialog'
import type { AiEvent, AiStreamRequest, FileNode } from '../types'

/**
 * Invoke a command whose result is delivered via a Channel instead of the
 * command's return value.
 * WHY: on this WebKitGTK build, async-command return values never resolve in
 * JS (sync commands + Channels both work), so long-running commands are sync
 * fns in Rust that stream their outcome over a Channel.
 */
function cmdWithChannel<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ch = new Channel<{ ok: boolean; value: T; error?: string }>()
    ch.onmessage = (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error ?? 'command failed')))
    invoke(cmd, { ...args, onResult: ch }).catch((e) => reject(new Error(String(e))))
  })
}

/**
 * Native pickers. Primary path is zenity/kdialog (Rust `pick_*` commands);
 * if no picker tool exists (macOS/Windows), fall back to plugin-dialog.
 * ponytail: rfd hangs pre-map on some Linux setups — see src-tauri/src/pick.rs.
 */

export async function pickFolder(): Promise<string | null> {
  try {
    return await cmdWithChannel<string | null>('pick_folder')
  } catch {
    const d = await pluginOpen({ directory: true })
    return typeof d === 'string' ? d : null
  }
}

export async function pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null> {
  try {
    return await cmdWithChannel<string | null>('pick_file')
  } catch {
    const p = await pluginOpen({ multiple: false, filters })
    return typeof p === 'string' ? p : null
  }
}

export async function pickSaveFile(defaultName: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> {
  try {
    return await cmdWithChannel<string | null>('pick_save', { defaultName })
  } catch {
    const p = await pluginSave({ defaultPath: defaultName, filters })
    return typeof p === 'string' ? p : null
  }
}

export const tauri = {
  /** Allow a user-consented path (pick/drop/launch) for fs + asset access. */
  fsAllow: (path: string) => invoke<void>('fs_allow', { path }),
  readDir: (path: string) => invoke<FileNode[]>('read_dir', { path }),
  readFile: (path: string) => invoke<string>('read_file', { path }),
  writeFile: (path: string, contents: string) => invoke<void>('write_file', { path, contents }),
  createFile: (path: string) => invoke<void>('create_file', { path }),
  createDir: (path: string) => invoke<void>('create_dir', { path }),
  rename: (path: string, newPath: string) => invoke<void>('rename', { path, newPath }),
  trash: (path: string) => invoke<void>('trash_path', { path }),
  watchStart: (root: string) => invoke<void>('watch_start', { root }),
  watchStop: () => invoke<void>('watch_stop'),
  recentGet: () => invoke<string[]>('recent_get'),
  recentPush: (path: string) => invoke<void>('recent_push', { path }),
  recentClear: () => invoke<void>('recent_clear'),
  settingsGet: () => invoke<Record<string, unknown>>('settings_get'),
  settingsSet: (settings: unknown) => invoke<void>('settings_set', { settings }),
  pathDir: (path: string) => invoke<string>('path_dir', { path }),
  pathJoin: (dir: string, name: string) => invoke<string>('path_join', { dir, name }),

  secretSet: (provider: string, key: string) => invoke<void>('secret_set', { provider, key }),
  secretDelete: (provider: string) => invoke<void>('secret_delete', { provider }),
  secretStatus: () => invoke<Record<string, boolean>>('secret_status'),

  ollamaModels: (ollamaUrl?: string) =>
    cmdWithChannel<string[]>('ollama_models', { ollamaUrl }),
  fetchModels: (provider: string, ollamaUrl?: string) =>
    cmdWithChannel<string[]>('fetch_models', { provider, ollamaUrl }),
  pandocAvailable: () => invoke<boolean>('pandoc_available'),
  exportPandoc: (src: string, format: string) =>
    cmdWithChannel<string>('export_pandoc', { src, format }),

  ttsAvailable: () => invoke<boolean>('tts_available'),
  ttsVoices: () => cmdWithChannel<string[]>('tts_voices'),
  ttsSpeak: (text: string, voice?: string) =>
    cmdWithChannel<boolean>('tts_speak', { text, voice }),
  ttsStop: () => invoke<void>('tts_stop'),

  storeGet: (name: string) => invoke<Record<string, unknown>>('store_get', { name }),
  storeSet: (name: string, value: unknown) => invoke<void>('store_set', { name, value }),

  /** Literal-substring search across text files in the workspace. */
  workspaceSearch: (root: string, query: string, caseSensitive: boolean) =>
    cmdWithChannel<
      { path: string; line: string; lineNo: number }[]
    >('workspace_search', { root, query, caseSensitive }),

  /** Files passed to the first app launch (`notepad foo.md`). */
  startupFiles: () => invoke<string[]>('startup_files'),
  /** Exit after the webview flushed pending saves (see quit-requested). */
  quitNow: () => invoke<void>('quit_now'),
  /** Last-resort save for dirty untitled tabs during quit. */
  saveRecovery: (title: string, contents: string) =>
    invoke<string>('save_recovery', { title, contents }),

  /** Copy a dropped/picked image next to the document; returns the relative path. */
  imageImport: (docDir: string, src: string) =>
    invoke<string>('image_import', { docDir, src }),
  /** Write a pasted clipboard image next to the document; returns the relative path. */
  imageSaveBytes: (docDir: string, ext: string, bytes: Uint8Array) =>
    invoke<string>('image_save_bytes', { docDir, ext, bytes: Array.from(bytes) }),

  /**
   * Stream an AI completion. Returns a cancel function; keys never reach the
   * frontend — Rust reads them from the OS keychain.
   */
  aiStream(req: AiStreamRequest, onEvent: (e: AiEvent) => void): () => void {
    const id = crypto.randomUUID()
    const ch = new Channel<AiEvent>()
    ch.onmessage = onEvent
    let cancelled = false
    invoke('ai_stream', { id, req, onEvent: ch }).catch((e) =>
      onEvent({ type: 'error', message: String(e) }),
    )
    return () => {
      if (cancelled) return
      cancelled = true
      invoke('ai_cancel', { id }).catch(() => {})
    }
  },
}

export { convertFileSrc }
