import { useEffect, useRef, useState } from 'react'
import { stream } from '../ai/client'
import { wordDiff } from '../ai/diff'
import { getSelection } from '../ai/selection'
import { BASE_SYSTEM, buildTransformPrompt, QUICK_ACTIONS } from '../ai/prompts'
import { replaceSelection } from '../editor/editBridge'
import { useToast } from '../stores/toast'

type Rect = { top: number; left: number; bottom: number; right: number } | null

/** Floating quick-action bar shown when a selection goes stable. */
export function SelectionActionBar({ rect, onAction }: { rect: Rect; onAction: (action: string, extra?: string) => void }) {
  const [customMode, setCustomMode] = useState(false)
  const [prompt, setPrompt] = useState('')

  return (
    <div className="transform-popover" style={popStyle(rect)}>
      {customMode ? (
        <input
          autoFocus
          className="transform-custom"
          placeholder="What should happen to the selected text?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && prompt.trim()) onAction('custom', prompt.trim())
            if (e.key === 'Escape') setCustomMode(false)
          }}
        />
      ) : (
        QUICK_ACTIONS.map((a) => (
          <button
            key={a.id}
            onClick={() =>
              a.id === 'custom' || a.id === 'translate'
                ? setCustomMode(true)
                : onAction(a.id)
            }
          >
            {a.label}
          </button>
        ))
      )}
    </div>
  )
}

/** Streaming old-vs-new diff card. `request` comes from a quick action or the palette. */
export function DiffPopover({
  request,
  selRect,
  onClose,
}: {
  request: { action: string; extra?: string }
  selRect: Rect
  onClose: () => void
}) {
  const [busy, setBusy] = useState(true)
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const original = useRef(getSelection().text.trim()).current
  const cancelRef = useRef<{ cancel: () => void } | null>(null)
  const cancelled = useRef(false)
  const errored = useRef(false)

  useEffect(() => {
    cancelRef.current = stream(
      [{ role: 'user', content: buildTransformPrompt(request.action, original, request.extra) }],
      BASE_SYSTEM,
      (delta) => setResult((r) => r + delta),
      () => {
        // Rust always sends Done after Error; only the first terminal state counts.
        if (!errored.current) setBusy(false)
      },
      (message) => {
        errored.current = true
        setBusy(false)
        setError(message)
      },
    )
    return () => cancelRef.current?.cancel()
    // Primitive deps: an object dep re-fired this stream on every App render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.action, request.extra, original])

  function doCancel() {
    cancelled.current = true
    cancelRef.current?.cancel()
    setBusy(false) // an aborted Rust task sends neither Done nor Error
  }

  async function apply() {
    // The diff was computed against a frozen snapshot; only apply if the
    // selection still is that text (otherwise the edit lands in the wrong place).
    const current = getSelection().text.trim()
    if (current !== original) {
      useToast.getState().show('Selection changed — reselect and retry')
      onClose()
      return
    }
    const ok = await replaceSelection(result.trim())
    if (!ok) useToast.getState().show('Could not apply the edit')
    onClose()
  }

  return (
    <div className="diff-popover" style={popStyle(selRect)}>
      <div className="diff-header">
        <span>{cancelled.current ? 'Stopped' : busy ? 'Working…' : 'Proposed change'}</span>
        {busy && <button onClick={doCancel}>Stop</button>}
      </div>
      <div className="diff-body">
        {error ? (
          <div className="diff-error">⚠ {error}</div>
        ) : (
          wordDiff(original, result.trim()).map((op, i) =>
            op.type === 'same' ? (
              <span key={i}>{op.text}</span>
            ) : op.type === 'del' ? (
              <del key={i} className="diff-del">{op.text}</del>
            ) : (
              <ins key={i} className="diff-add">{op.text}</ins>
            ),
          )
        )}
      </div>
      <div className="diff-footer">
        <button onClick={onClose}>Discard</button>
        {!busy && !error && (
          <button className="primary" onClick={() => void apply()}>Apply</button>
        )}
      </div>
    </div>
  )
}

function popStyle(rect: Rect): React.CSSProperties {
  if (!rect) return { top: '30%', left: '50%', transform: 'translateX(-50%)' }
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - 470)
  const below = rect.bottom + 8
  return below + 230 > window.innerHeight
    ? { top: Math.max(12, rect.top - 240), left }
    : { top: below, left }
}
