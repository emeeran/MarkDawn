import { create } from 'zustand'
import { dbg, tauri } from '../lib/tauri'
import { useToast } from './toast'
import type { FileNode } from '../types'

interface WorkspaceStore {
  root: string | null
  tree: FileNode[]
  expanded: Set<string>
  openRoot: (path: string) => Promise<void>
  closeRoot: () => void
  refresh: (dir?: string) => Promise<void>
  toggleExpanded: (path: string) => void
}

export const useWorkspace = create<WorkspaceStore>((setState, get) => ({
  root: null,
  tree: [],
  expanded: new Set(),

  async openRoot(path) {
    void dbg(`openRoot: start ${path}`)
    try {
      await tauri.watchStart(path)
      void dbg('openRoot: watch ok')
    } catch (e) {
      void dbg(`openRoot: watch FAILED ${e}`)
    }
    setState({ root: path, expanded: new Set([path]) })
    await get().refresh(path)
    void dbg(`openRoot: tree ${get().tree.length} entries`)
    useToast.getState().show(`[dbg] tree: ${get().tree.length} entries`) // DEBUG
  },

  closeRoot() {
    void tauri.watchStop()
    setState({ root: null, tree: [] })
  },

  async refresh(dir) {
    const root = get().root
    if (!root) return
    const target = dir ?? root
    try {
      const nodes = await tauri.readDir(target)
      setState((s) => {
        if (target === root) return { tree: nodes }
        const replace = (list: FileNode[]): FileNode[] =>
          list.map((n) =>
            n.path === target ? { ...n, children: nodes } : { ...n, children: n.children ? replace(n.children) : n.children },
          )
        return { tree: replace(s.tree) }
      })
    } catch {
      /* deleted out from under us; tree refresh on next fs event */
    }
  },

  toggleExpanded(path) {
    setState((s) => {
      const next = new Set(s.expanded)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        void get().refresh(path)
      }
      return { expanded: next }
    })
  },
}))
