import { invoke, Channel, convertFileSrc } from '@tauri-apps/api/core'
import type { AiEvent, AiStreamRequest, FileNode } from '../types'

export const tauri = {
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
  settingsGet: () => invoke<Record<string, unknown>>('settings_get'),
  settingsSet: (settings: unknown) => invoke<void>('settings_set', { settings }),
  pathExists: (path: string) => invoke<boolean>('path_exists', { path }),
  pathDir: (path: string) => invoke<string>('path_dir', { path }),
  pathJoin: (dir: string, name: string) => invoke<string>('path_join', { dir, name }),

  secretSet: (provider: string, key: string) => invoke<void>('secret_set', { provider, key }),
  secretDelete: (provider: string) => invoke<void>('secret_delete', { provider }),
  secretStatus: () => invoke<Record<string, boolean>>('secret_status'),

  ollamaModels: (ollamaUrl?: string) => invoke<string[]>('ollama_models', { ollamaUrl }),
  pandocAvailable: () => invoke<boolean>('pandoc_available'),
  exportPandoc: (src: string, format: string) => invoke<string>('export_pandoc', { src, format }),

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
