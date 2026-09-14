import { create } from 'zustand'
import { save } from '@tauri-apps/plugin-dialog'
import { tauri } from '../lib/tauri'
import type { Tab } from '../types'
import { useToast } from './toast'

interface TabsStore {
  tabs: Tab[]
  activeId: string | null
  banner: string | null // external-change prompt for the active tab
  open: (path: string) => Promise<void>
  openUntitled: () => void
  close: (id: string) => Promise<void>
  setActive: (id: string) => void
  setContent: (id: string, markdown: string) => void
  markSaved: (id: string, markdown: string) => void
  saveById: (id: string) => Promise<void>
  saveActive: () => Promise<void>
  saveActiveAs: () => Promise<void>
  setBanner: (msg: string | null) => void
}

let saveTimer: ReturnType<typeof setTimeout> | undefined

export const useTabs = create<TabsStore>((setState, get) => ({
  tabs: [],
  activeId: null,
  banner: null,

  async open(path) {
    const existing = get().tabs.find((t) => t.path === path)
    if (existing) {
      setState({ activeId: existing.id, banner: null })
      return
    }
    try {
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
    if (tab.dirty) {
      if (tab.path) {
        await get().saveById(id)
      } else {
        await get().saveActiveAs()
      }
    }
    setState((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeId =
        s.activeId === id ? (tabs[idx]?.id ?? tabs.at(-1)?.id ?? null) : s.activeId
      return { tabs, activeId }
    })
  },

  setActive(id) {
    setState({ activeId: id, banner: null })
  },

  setContent(id, markdown) {
    // Ignore echoes of content we already have (e.g. editor json-change after
    // an external reload) so a freshly reloaded tab doesn't turn dirty.
    const current = get().tabs.find((t) => t.id === id)
    if (!current || current.markdown === markdown) return
    setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, markdown, dirty: true } : t)),
    }))
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void get().saveById(id), 500)
  },

  markSaved(id, markdown) {
    setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, markdown, dirty: false } : t)) }))
  },

  async saveById(id) {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || !tab.dirty) return
    if (!tab.path) return get().saveActiveAs()
    try {
      await tauri.writeFile(tab.path, tab.markdown)
      get().markSaved(id, tab.markdown)
    } catch (e) {
      useToast.getState().show(`Save failed: ${e}`)
    }
  },

  async saveActive() {
    const id = get().activeId
    if (id) await get().saveById(id)
  },

  async saveActiveAs() {
    const id = get().activeId
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    const path = await save({
      defaultPath: `${tab.title}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    }).catch((e) => {
      useToast.getState().show(`Save as: ${e}`)
      return null
    })
    if (!path) return
    await tauri.writeFile(path, tab.markdown)
    setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, path, title: path.split(/[\\/]/).pop() ?? path, dirty: false } : t,
      ),
    }))
    void tauri.recentPush(path)
  },

  setBanner(msg) {
    setState({ banner: msg })
  },
}))
