import { useState } from 'react'
import { tauri } from '../lib/tauri'
import { useTabs } from '../stores/tabs'
import { useToast } from '../stores/toast'
import { useWorkspace } from '../stores/workspace'
import type { FileNode } from '../types'

export function FileTree() {
  const { root, tree, refresh } = useWorkspace()
  const [creating, setCreating] = useState<null | 'file' | 'dir'>(null)
  const [newName, setNewName] = useState('')

  if (!root) {
    return (
      <div className="panel-empty">
        <button onClick={() => void pickFolder()}>Open folder…</button>
      </div>
    )
  }

  async function create(kind: 'file' | 'dir') {
    const name = newName.trim()
    if (!name) return
    const path = await tauri.pathJoin(root!, name)
    try {
      if (kind === 'file') await tauri.createFile(path)
      else await tauri.createDir(path)
      setCreating(null)
      setNewName('')
      await refresh()
      if (kind === 'file') void useTabs.getState().open(path)
    } catch (e) {
      useToast.getState().show(String(e))
    }
  }

  return (
    <div className="file-tree">
      <div className="tree-header">
        <span className="tree-root" title={root}>
          {root.split(/[\\/]/).pop()}
        </span>
        <button title="New file" onClick={() => { setCreating('file'); setNewName('') }}>＋</button>
        <button title="New folder" onClick={() => { setCreating('dir'); setNewName('') }}>＋▣</button>
        <button title="Close folder" onClick={() => useWorkspace.getState().closeRoot()}>✕</button>
      </div>
      {creating && (
        <input
          className="tree-input"
          autoFocus
          placeholder={creating === 'file' ? 'file name…' : 'folder name…'}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create(creating)
            if (e.key === 'Escape') setCreating(null)
          }}
        />
      )}
      <div className="tree-body">
        {tree.map((n) => (
          <TreeNode key={n.path} node={n} depth={0} />
        ))}
      </div>
    </div>
  )
}

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const { expanded, toggleExpanded, refresh } = useWorkspace()
  const open = useTabs((s) => s.open)
  const activePath = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.path)
  const isOpen = expanded.has(node.path)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(node.name)

  async function doRename() {
    const trimmed = name.trim()
    setRenaming(false)
    if (!trimmed || trimmed === node.name) return
    const parent = await tauri.pathDir(node.path)
    const newPath = await tauri.pathJoin(parent, trimmed)
    try {
      await tauri.rename(node.path, newPath)
      await refresh(await tauri.pathDir(node.path))
    } catch (e) {
      useToast.getState().show(String(e))
    }
  }

  async function doDelete() {
    try {
      await tauri.trash(node.path)
      await refresh(await tauri.pathDir(node.path))
    } catch (e) {
      useToast.getState().show(String(e))
    }
  }

  return (
    <div>
      <div
        className={`tree-item ${node.path === activePath ? 'active' : ''}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => (node.isDir ? toggleExpanded(node.path) : void open(node.path))}
        onDoubleClick={() => { if (!node.isDir) { setName(node.name); setRenaming(true) } }}
      >
        <span className="tree-icon">{node.isDir ? (isOpen ? '▾' : '▸') : '≡'}</span>
        {renaming ? (
          <input
            className="tree-input"
            autoFocus
            value={name}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void doRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <>
            <span className="tree-name">{node.name}</span>
            <span className="tree-actions">
              <button
                title="Delete"
                onClick={(e) => { e.stopPropagation(); void doDelete() }}
              >
                ✕
              </button>
            </span>
          </>
        )}
      </div>
      {node.isDir && isOpen && node.children?.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} />)}
    </div>
  )
}

async function pickFolder() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const dir = await open({ directory: true })
  if (typeof dir === 'string') void useWorkspace.getState().openRoot(dir)
}
