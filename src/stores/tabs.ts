import { create } from 'zustand'
import { flushPendingEmit } from '../editor/editBridge'
import { pickSaveFile, tauri } from '../lib/tauri'
import type { Tab } from '../types'
import { useToast } from './toast'

interface ClosedTab {
  path: string | null
  title: string
  markdown: string
}

interface TabsStore {
  tabs: Tab[]
  activeId: string | null
  banner: string | null // external-change prompt for the active tab
  closed: ClosedTab[] // for reopen-closed-tab (⌘⇧T), newest first
  open: (path: string) => Promise<void>
  openUntitled: () => void
  close: (id: string) => Promise<void>
  reopenClosed: () => Promise<void>
  setActive: (id: string) => void
  setContent: (id: string, markdown: string) => void
  /** Toggle the active tab between markdown rendering and raw plain text. */
  togglePlainText: () => void
  /** Active tab is in plain-text (raw) view? */
  activePlain: () => boolean
  markSaved: (id: string, markdown: string, mtime?: number | null) => void
  saveById: (id: string) => Promise<'saved' | 'failed' | 'skipped'>
  saveActive: () => Promise<void>
  saveActiveAs: () => Promise<boolean>
  setBanner: (msg: string | null) => void
  /** Write every dirty named tab now; untitled dirty tabs go to recovery.
   *  `failed` lists titles whose save did NOT land — quit must not exit
   *  while it is non-empty (the dirty buffers are the only copy). */
  flushAll: () => Promise<{ recovered: string[]; failed: string[] }>
  /** Record that a just-started write will echo back via fs-changed. */
  noteSelfSave: (path: string) => void
  /** True (once) if this fs-changed event is our own write's echo. */
  consumeSelfSave: (path: string) => boolean
  /** True while within the echo window of our own write (atomic writes can
   *  emit more than one fs-changed event for the target). */
  wasSelfSaveRecently: (path: string) => boolean
  /** Mark a dirty tab's file as changed on disk elsewhere. */
  markStale: (path: string) => void
  clearStale: (path: string) => void
  /** "Keep mine" on the external-change banner: keep the buffer, drop the
   *  mtime guard so the next save deliberately overwrites the disk version. */
  keepMine: (id: string) => void
}

// One timer per tab. A single shared timer let typing in tab B cancel tab A's
// pending write — the root of several silent-data-loss bugs.
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Paths with a write in flight; their fs-changed echo is ours, not external.
const selfSaves = new Set<string>()

// When our last write started. Atomic rename commonly emits more than one
// fs-changed event for the target; events within this window are echoes.
// ponytail: 1s window can mask a genuinely external write in that sliver —
// the mtime guard on write_file is what actually protects the data.
const selfSaveAt = new Map<string, number>()
const SELF_SAVE_ECHO_MS = 1000

// Dirty tabs whose file changed on disk behind our backs. Surfaced as a
// banner when the tab is (or becomes) active.
const stalePaths = new Set<string>()

function clearTimer(id: string) {
  const t = saveTimers.get(id)
  if (t) {
    clearTimeout(t)
    saveTimers.delete(id)
  }
}

export const useTabs = create<TabsStore>((setState, get) => ({
  tabs: [],
  activeId: null,
  banner: null,
  closed: [],

  async open(path) {
    const existing = get().tabs.find((t) => t.path === path)
    if (existing) {
      setState({ activeId: existing.id, banner: null })
      return
    }
    try {
      await tauri.fsAllow(path) // user-launched/dropped/picked → consented
      const markdown = await tauri.readFile(path)
      const mtime = await tauri.statMtime(path).catch(() => null)
      const tab: Tab = {
        id: crypto.randomUUID(),
        path,
        title: path.split(/[\\/]/).pop() ?? path,
        dirty: false,
        markdown,
        mtime,
        plainText: /\.(txt|log)$/i.test(path),
      }
      setState((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id, banner: null }))
      void tauri.recentPush(path).catch((e) => console.warn('recent files:', e))
    } catch (e) {
      useToast.getState().show(`Cannot open ${path}: ${e}`)
    }
  },

  openUntitled() {
    const tab: Tab = { id: crypto.randomUUID(), path: null, title: 'untitled', dirty: false, markdown: '', mtime: null }
    setState((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }))
  },

  async close(id) {
    flushPendingEmit() // the editor's debounced tail belongs to this save
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    clearTimer(id)
    if (tab.dirty && tab.path) {
      const result = await get().saveById(id)
      if (result === 'failed') return // save failed — keep the tab open
    }
    // A dirty tab that never had a path is scratch — closing discards it.
    setState((s) => {
      // Re-read: Save-As may have changed path/title.
      const t = s.tabs.find((t) => t.id === id)
      const closedTab = t?.path ? { path: t.path, title: t.title, markdown: t.markdown } : null
      const idx = s.tabs.findIndex((x) => x.id === id)
      const tabs = s.tabs.filter((x) => x.id !== id)
      const activeId =
        s.activeId === id ? (tabs[idx]?.id ?? tabs.at(-1)?.id ?? null) : s.activeId
      return {
        tabs,
        activeId,
        closed: closedTab ? [closedTab, ...s.closed].slice(0, 10) : s.closed,
      }
    })
  },

  async reopenClosed() {
    const last = get().closed[0]
    if (!last) return
    setState((s) => ({ closed: s.closed.slice(1) }))
    if (last.path) {
      await get().open(last.path)
      // open() may have failed (file deleted) — fall back to the buffer we kept.
      if (!get().tabs.some((t) => t.path === last.path)) {
        get().openUntitled()
        const tab = get().tabs.at(-1)
        if (tab) get().setContent(tab.id, last.markdown)
      }
    } else {
      get().openUntitled()
      const tab = get().tabs.at(-1)
      if (tab) get().setContent(tab.id, last.markdown)
    }
  },

  setActive(id) {
    flushPendingEmit() // flush the OUTGOING tab's tail into its own tab first
    const tab = get().tabs.find((t) => t.id === id)
    const stale = tab?.path ? stalePaths.has(tab.path) : false
    setState({ activeId: id, banner: stale ? 'This file changed on disk.' : null })
  },

  togglePlainText() {
    setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, plainText: !t.plainText } : t)),
    }))
  },

  activePlain() {
    const t = get().tabs.find((x) => x.id === get().activeId)
    return !!t?.plainText
  },

  setContent(id, markdown) {
    // Ignore echoes of content we already have (e.g. editor json-change after
    // an external reload) so a freshly reloaded tab doesn't turn dirty.
    const current = get().tabs.find((t) => t.id === id)
    if (!current || current.markdown === markdown) return
    setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, markdown, dirty: true } : t)),
    }))
    clearTimer(id)
    saveTimers.set(
      id,
      setTimeout(() => {
        saveTimers.delete(id)
        void get().saveById(id)
      }, 500),
    )
  },

  markSaved(id, markdown, mtime) {
    setState((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t
        // If the user typed while the save was in flight, keep the tab dirty —
        // silently adopting the older snapshot would drop those edits.
        if (t.markdown !== markdown) return t
        return { ...t, dirty: false, ...(mtime !== undefined ? { mtime } : {}) }
      }),
    }))
  },

  /** Save one tab to its known path. Never opens dialogs. */
  async saveById(id) {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || !tab.dirty || !tab.path) return 'skipped' // untitled autosave must not pop a dialog
    try {
      get().noteSelfSave(tab.path)
      const mtime = await tauri.writeFile(tab.path, tab.markdown, tab.mtime)
      get().markSaved(id, tab.markdown, mtime)
      return 'saved'
    } catch (e) {
      selfSaves.delete(tab.path)
      if (String(e).includes('mtime-conflict')) {
        // The file changed on disk behind our backs — surface the conflict
        // instead of clobbering whichever external writer got there first.
        // Halt the autosave chain and toast once; the stale flag dedupes so
        // continued typing can't turn this into a toast every 500ms.
        clearTimer(id)
        const first = !stalePaths.has(tab.path)
        get().markStale(tab.path)
        if (tab.id === get().activeId) get().setBanner('This file changed on disk.')
        if (first) useToast.getState().show('Save blocked — the file changed on disk')
      } else {
        useToast.getState().show(`Save failed: ${e}`)
      }
      return 'failed'
    }
  },

  async saveActive() {
    const id = get().activeId
    if (!id) return
    const tab = get().tabs.find((t) => t.id === id)
    // Manual ⌘S on an untitled tab goes through Save-As; autosave must not.
    if (tab && !tab.path) {
      await get().saveActiveAs()
      return
    }
    await get().saveById(id)
  },

  /** Save-As for a specific tab (activates it first). False = cancelled/failed. */
  async saveActiveAs() {
    const id = get().activeId
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return false
    const path = await pickSaveFile(
      // Don't double-extend files that already carry one (notes.txt → notes.txt.md)
      /\.[^./\\]+$/.test(tab.title) ? tab.title : `${tab.title}.md`,
      [{ name: 'Markdown', extensions: ['md'] }],
    ).catch((e) => {
      useToast.getState().show(`Save as: ${e}`)
      return null
    })
    if (!path) return false
    // Two tabs on one path = each autosave silently clobbering the other,
    // hidden by the self-save echo. Block the pair from forming at all.
    const clash = get().tabs.find((t) => t.id !== id && t.path === path)
    if (clash) {
      useToast.getState().show(`"${clash.title}" is already open in another tab — close it first`)
      return false
    }
    try {
      await tauri.fsAllow(path)
      // Overwriting an existing file this tab never loaded must not silently
      // clobber it: pass its current mtime so a concurrent change is caught.
      const existingMtime = await tauri.statMtime(path).catch(() => null)
      const mtime = await tauri.writeFile(path, tab.markdown, existingMtime)
      setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id
            ? { ...t, path, title: path.split(/[\\/]/).pop() ?? path, dirty: false, mtime }
            : t,
        ),
      }))
    } catch (e) {
      useToast.getState().show(`Save failed: ${e}`)
      return false
    }
    void tauri.recentPush(path).catch((e) => console.warn('recent files:', e))
    return true
  },

  setBanner(msg) {
    setState({ banner: msg })
  },

  noteSelfSave(path) {
    selfSaves.add(path)
    selfSaveAt.set(path, Date.now())
  },

  consumeSelfSave(path) {
    return selfSaves.delete(path)
  },

  wasSelfSaveRecently(path) {
    const at = selfSaveAt.get(path)
    if (at === undefined) return false
    if (Date.now() - at >= SELF_SAVE_ECHO_MS) {
      selfSaveAt.delete(path)
      return false
    }
    return true
  },

  markStale(path) {
    stalePaths.add(path)
  },

  clearStale(path) {
    stalePaths.delete(path)
  },

  keepMine(id) {
    const tab = get().tabs.find((t) => t.id === id)
    if (tab?.path) stalePaths.delete(tab.path)
    setState((s) => ({
      banner: null,
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, mtime: null } : t)),
    }))
  },

  async flushAll() {
    const recovered: string[] = []
    const failed: string[] = []
    for (const tab of get().tabs) {
      if (!tab.dirty) continue
      if (tab.path) {
        if ((await get().saveById(tab.id)) === 'failed') failed.push(tab.title)
      } else {
        try {
          const where = await tauri.saveRecovery(tab.title, tab.markdown)
          recovered.push(where)
        } catch {
          /* last resort failed — nothing more we can do */
        }
      }
    }
    if (recovered.length > 0) {
      useToast.getState().show(`Untitled work saved to ${recovered.join(', ')}`)
    }
    return { recovered, failed }
  },
}))
