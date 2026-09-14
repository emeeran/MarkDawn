import { useEffect, useRef, useState } from 'react'
import { findNext, findPrevious, replace, replaceAll, search } from '../editor/editBridge'
import { useSettings } from '../stores/settings'

interface Props {
  onClose: () => void
}

export function FindBar({ onClose }: Props) {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [isRegexp, setIsRegexp] = useState(false)
  const [isCaseSensitive, setCase] = useState(false)
  const [isWholeWord, setWholeWord] = useState(false)
  const [showReplace, setShowReplace] = useState(false)
  const queryRef = useRef<HTMLInputElement>(null)

  // Opened via workspace search: pre-fill and run the search immediately.
  const preset = useSettings((s) => s.findQuery)
  useEffect(() => {
    if (!preset) return
    setQuery(preset)
    search(preset, { isCaseSensitive, isWholeWord })
    findNext()
    useSettings.getState().set('findQuery', '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    queryRef.current?.focus()
  }, [])

  function runSearch(q = query) {
    if (!q) return
    search(q, { isRegexp, isCaseSensitive, isWholeWord })
    findNext()
  }

  // Toggling an option re-runs the search so highlights follow immediately.
  function toggleOpt(kind: 'case' | 'word' | 'regex') {
    const next = {
      isCaseSensitive: kind === 'case' ? !isCaseSensitive : isCaseSensitive,
      isWholeWord: kind === 'word' ? !isWholeWord : isWholeWord,
      isRegexp: kind === 'regex' ? !isRegexp : isRegexp,
    }
    setCase(next.isCaseSensitive)
    setWholeWord(next.isWholeWord)
    setIsRegexp(next.isRegexp)
    if (query) {
      search(query, next)
      findNext()
    }
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
        <label className="find-opt" title="Match case">
          <input type="checkbox" checked={isCaseSensitive} onChange={() => toggleOpt('case')} /> Aa
        </label>
        <label className="find-opt" title="Whole word">
          <input type="checkbox" checked={isWholeWord} onChange={() => toggleOpt('word')} /> |w|
        </label>
        <label className="find-opt" title="Regular expression">
          <input type="checkbox" checked={isRegexp} onChange={() => toggleOpt('regex')} /> .*
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
