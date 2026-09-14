import { create } from 'zustand'
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
  markSaved: (id: string, markdown: string) => void
  saveById: (id: string) => Promise<'saved' | 'failed' | 'skipped'>
  saveActive: () => Promise<void>
  saveActiveAs: () => Promise<boolean>
  setBanner: (msg: string | null) => void
  /** Write every dirty named tab now; untitled dirty tabs go to recovery. Used on quit. */
  flushAll: () => Promise<string[]>
  /** Record that a just-started write will echo back via fs-changed. */
  noteSelfSave: (path: string) => void
  /** True (once) if this fs-changed event is our own write's echo. */
  consumeSelfSave: (path: string) => boolean
  /** Mark a dirty tab's file as changed on disk elsewhere. */
  markStale: (path: string) => void
  clearStale: (path: string) => void
}

// One timer per tab. A single shared timer let typing in tab B cancel tab A's
// pending write — the root of several silent-data-loss bugs.
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Paths with a write in flight; their fs-changed echo is ours, not external.
const selfSaves = new Set<string>()

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
      const tab: Tab = {
        id: crypto.randomUUID(),
        path,
        title: path.split(/[\\/]/).pop() ?? path,
        dirty: false,
        markdown,
      }
      setState((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id, banner: null }))
      void tauri.recentPush(path)
    } catch (e) {
      useToast.getState().show(`Cannot open ${path}: ${e}`)
    }
  },

  openUntitled() {
    const tab: Tab = { id: crypto.randomUUID(), path: null, title: 'untitled', dirty: false, markdown: '' }
    setState((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }))
  },

  async close(id) {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    clearTimer(id)
    if (tab.dirty) {
      if (tab.path) {
        const result = await get().saveById(id)
        if (result === 'failed') return // save failed — keep the tab open
      } else {
        // Never had a path: activate it so Save-As targets THIS tab (a
        // background tab used to save the active tab's content), then the
        // user picks a destination — or the close is cancelled.
        setState({ activeId: id })
        const saved = await get().saveActiveAs()
        if (!saved) return
      }
    }
    setState((s) => {
      // Re-read: Save-As may have changed path/title.
      const t = s.tabs.find((t) => t.id === id)
      const closedTab = t ? { path: t.path, title: t.title, markdown: t.markdown } : null
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
    const tab = get().tabs.find((t) => t.id === id)
    const stale = tab?.path ? stalePaths.has(tab.path) : false
    setState({ activeId: id, banner: stale ? 'This file changed on disk.' : null })
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

  markSaved(id, markdown) {
    setState((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t
        // If the user typed while the save was in flight, keep the tab dirty —
        // silently adopting the older snapshot would drop those edits.
        return t.markdown === markdown ? { ...t, dirty: false } : t
      }),
    }))
  },

  /** Save one tab to its known path. Never opens dialogs. */
  async saveById(id) {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || !tab.dirty || !tab.path) return 'skipped' // untitled autosave must not pop a dialog
    try {
      get().noteSelfSave(tab.path)
      await tauri.writeFile(tab.path, tab.markdown)
      get().markSaved(id, tab.markdown)
      return 'saved'
    } catch (e) {
      selfSaves.delete(tab.path)
      useToast.getState().show(`Save failed: ${e}`)
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
    const path = await pickSaveFile(`${tab.title}.md`, [
      { name: 'Markdown', extensions: ['md'] },
    ]).catch((e) => {
      useToast.getState().show(`Save as: ${e}`)
      return null
    })
    if (!path) return false
    try {
      await tauri.fsAllow(path)
      await tauri.writeFile(path, tab.markdown)
    } catch (e) {
      useToast.getState().show(`Save failed: ${e}`)
      return false
    }
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, path, title: path.split(/[\\/]/).pop() ?? path, dirty: false } : t,
      ),
    }))
    void tauri.recentPush(path)
    return true
  },

  setBanner(msg) {
    setState({ banner: msg })
  },

  noteSelfSave(path) {
    selfSaves.add(path)
  },

  consumeSelfSave(path) {
    return selfSaves.delete(path)
  },

  markStale(path) {
    stalePaths.add(path)
  },

  clearStale(path) {
    stalePaths.delete(path)
  },

  async flushAll() {
    const recovered: string[] = []
    for (const tab of get().tabs) {
      if (!tab.dirty) continue
      if (tab.path) {
        await get().saveById(tab.id)
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
    return recovered
  },
}))
