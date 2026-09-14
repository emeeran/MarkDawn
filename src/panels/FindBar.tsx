import { useEffect, useRef, useState } from 'react'
import { findNext, findPrevious, replace, replaceAll, search } from '../editor/editBridge'

interface Props {
  onClose: () => void
}

export function FindBar({ onClose }: Props) {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [isRegexp, setIsRegexp] = useState(false)
  const [showReplace, setShowReplace] = useState(false)
  const queryRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    queryRef.current?.focus()
  }, [])

  function runSearch(q = query) {
    if (!q) return
    search(q, { isRegexp, isCaseSensitive: false })
    findNext()
  }

  return (
    <div className="find-bar">
      <div className="find-row">
        <button title="Find previous (⇧Enter)" onClick={() => (query ? findPrevious() : undefined)}>↑</button>
        <button title="Find next (Enter)" onClick={() => runSearch()}>↓</button>
        <input
          ref={queryRef}
          placeholder="Find"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.shiftKey ? findPrevious() : runSearch())
            if (e.key === 'Escape') onClose()
          }}
        />
        <label className="find-opt">
          <input type="checkbox" checked={isRegexp} onChange={(e) => setIsRegexp(e.target.checked)} /> .*
        </label>
        <button title="Toggle replace" onClick={() => setShowReplace(!showReplace)}>⇄</button>
        <button title="Close (Esc)" onClick={onClose}>✕</button>
      </div>
      {showReplace && (
        <div className="find-row">
          <input
            placeholder="Replace with"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query) replace(replacement, { isSingle: true, isRegexp })
              if (e.key === 'Escape') onClose()
            }}
          />
          <button disabled={!query} onClick={() => replace(replacement, { isSingle: true, isRegexp })}>
            Replace
          </button>
          <button disabled={!query} onClick={() => replaceAll(replacement, { isRegexp })}>
            All
          </button>
        </div>
      )}
    </div>
  )
}
