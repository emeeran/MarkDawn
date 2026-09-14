import { useEffect, useRef, useState } from 'react'
import { tauri } from '../lib/tauri'
import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'
import { useToast } from '../stores/toast'
import { useWorkspace } from '../stores/workspace'

interface Hit {
  path: string
  line: string
  lineNo: number
}

/**
 * Literal-substring search across the workspace (Rust side; no ripgrep).
 * Enter/click opens the file and pre-fills the find bar with the query so
 * Muya's search engine jumps to the match.
 */
export function WorkspaceSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [index, setIndex] = useState(0)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const root = useWorkspace((s) => s.root)

  useEffect(() => inputRef.current?.focus(), [])

  async function run() {
    const q = query.trim()
    if (!q || !root) return
    setSearching(true)
    try {
      const results = await tauri.workspaceSearch(root, q, caseSensitive)
      setHits(results)
      setIndex(0)
    } catch (e) {
      useToast.getState().show(`Search: ${e}`)
    } finally {
      setSearching(false)
    }
  }

  // Re-run on query change (debounced) once a first search happened.
  useEffect(() => {
    if (hits === null) return
    const t = setTimeout(() => void run(), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive])

  function openHit(hit?: Hit) {
    if (!hit) return
    onClose()
    const settings = useSettings.getState()
    void useTabs.getState().open(hit.path).then(() => {
      settings.set('findQuery', query.trim())
      settings.set('findOpen', true)
    })
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="find-row">
          <input
            ref={inputRef}
            autoFocus
            placeholder={root ? `Search in ${root.split(/[\\/]/).pop()}…` : 'Open a folder first…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (hits && hits[index] ? openHit(hits[index]) : void run())
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, (hits?.length ?? 1) - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
              if (e.key === 'Escape') onClose()
            }}
          />
          <label className="find-opt" title="Match case">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Aa
          </label>
        </div>
        <div className="palette-list">
          {!root && <div className="palette-item muted">Open a folder to search it</div>}
          {root && hits === null && <div className="palette-item muted">Type to search…</div>}
          {searching && <div className="palette-item muted">Searching…</div>}
          {hits?.map((h, i) => (
            <div
              key={`${h.path}:${h.lineNo}:${i}`}
              className={`palette-item ws-hit ${i === index ? 'selected' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => openHit(h)}
            >
              <span className="ws-line">{h.line.trim().slice(0, 120) || '∅'}</span>
              <span className="palette-section">{h.path.split(/[\\/]/).pop()}:{h.lineNo}</span>
            </div>
          ))}
          {hits && !searching && hits.length === 0 && <div className="palette-item muted">No matches</div>}
        </div>
      </div>
    </div>
  )
}
