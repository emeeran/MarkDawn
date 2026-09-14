import { useEffect, useMemo, useRef, useState } from 'react'
import { getCommands, type Command } from '../commands/registry'
import { useWorkspace } from '../stores/workspace'

interface Props {
  mode: 'actions' | 'files'
  onClose: () => void
}

export function CommandPalette({ mode, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const commands: Command[] = useMemo(() => {
    if (mode === 'actions') return getCommands()
    // files mode: flatten the workspace tree
    const { tree } = useWorkspace.getState()
    const files: Command[] = []
    const walk = (nodes: typeof tree) => {
      for (const n of nodes) {
        if (!n.isDir) files.push({ id: `file:${n.path}`, title: n.name, section: 'File', run: () => void useWorkspaceOpen(n.path) })
        if (n.children) walk(n.children)
      }
    }
    walk(tree)
    return files
  }, [mode])

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    const list = q
      ? commands.filter((c) => fuzzy(c.title.toLowerCase(), q)).sort((a, b) => score(b.title.toLowerCase(), q) - score(a.title.toLowerCase(), q))
      : commands
    return list.slice(0, 40)
  }, [commands, query])

  useEffect(() => setIndex(0), [query])

  function execute(cmd?: Command) {
    if (!cmd) return
    onClose()
    cmd.run()
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          autoFocus
          placeholder={mode === 'files' ? 'Go to file…' : 'Type a command…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
            if (e.key === 'Enter') execute(filtered[index])
            if (e.key === 'Escape') onClose()
          }}
        />
        <div className="palette-list">
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`palette-item ${i === index ? 'selected' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => execute(c)}
            >
              <span>{c.title}</span>
              {c.section && <span className="palette-section">{c.section}</span>}
            </div>
          ))}
          {filtered.length === 0 && <div className="palette-item muted">No matches</div>}
        </div>
      </div>
    </div>
  )
}

async function useWorkspaceOpen(path: string) {
  const { useTabs } = await import('../stores/tabs')
  void useTabs.getState().open(path)
}

function fuzzy(text: string, q: string): boolean {
  let i = 0
  for (const ch of text) {
    if (ch === q[i]) i++
    if (i === q.length) return true
  }
  return i === q.length
}

function score(text: string, q: string): number {
  if (text.startsWith(q)) return 100
  const idx = text.indexOf(q)
  if (idx >= 0) return 60 - Math.min(idx, 50)
  // subsequence: fewer gaps = better
  let gaps = 0
  let last = -2
  for (const ch of q) {
    const i = text.indexOf(ch, last + 1)
    if (i < 0) return 0
    if (i !== last + 1) gaps++
    last = i
  }
  return 30 - gaps
}
