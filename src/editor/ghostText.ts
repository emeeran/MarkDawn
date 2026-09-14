import { stream } from '../ai/client'
import { readDomSelection } from '../ai/selection'
import { GHOST_SYSTEM } from '../ai/prompts'
import { getMarkdown } from './editBridge'

/**
 * Ghost-text inline autocomplete: idle at end of a paragraph → stream a short
 * continuation into a grey overlay → Tab accepts, any other key dismisses.
 * Default OFF in settings.
 */

interface GhostHooks {
  enabled: () => boolean
  request: (context: string, onDelta: (t: string) => void) => { cancel: () => void }
  insert: (text: string) => void
}

let hooks: GhostHooks | null = null
let overlay: HTMLDivElement | null = null
let pendingTimer: ReturnType<typeof setTimeout> | undefined
let activeCancel: { cancel: () => void } | null = null
let accepted = false
let attached = false

export function attachGhostText(h: GhostHooks) {
  if (attached) return // idempotent — double-attach leaked duplicate listeners
  attached = true
  hooks = h
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('mousedown', dismiss)
  window.addEventListener('scroll', dismiss, true)
}

export function detachGhostText() {
  if (!attached && !hooks) return
  attached = false
  hooks = null
  cancelStream()
  clearTimeout(pendingTimer)
  document.removeEventListener('keydown', onKeyDown, true)
  document.removeEventListener('mousedown', dismiss)
  window.removeEventListener('scroll', dismiss, true)
  removeOverlay()
}

export function scheduleGhost() {
  if (!hooks?.enabled()) return
  clearTimeout(pendingTimer)
  pendingTimer = setTimeout(maybeTrigger, 700)
}

function maybeTrigger() {
  if (!hooks?.enabled() || activeCancel) return
  const sel = window.getSelection()
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0 || sel.anchorNode?.nodeType !== Node.TEXT_NODE) return

  const textNode = sel.anchorNode as Text
  const atEnd = sel.anchorOffset >= textNode.length
  if (!atEnd) return // only suggest at end of a line/block

  const blockText = (textNode.parentElement?.textContent ?? '').slice(-2000)
  if (blockText.trim().length < 10) return // nothing to continue

  const rect = readDomSelection().rect
  accepted = false
  let acc = ''
  activeCancel = hooks.request(blockText, (delta) => {
    acc += delta
    if (!overlay && rect) showOverlay(rect)
    if (overlay) {
      // Single-line only: continuation is inserted as inline text.
      const line = acc.split('\n')[0]
      overlay.textContent = line
    }
  })
}

function showOverlay(rect: { top: number; left: number; bottom: number }) {
  removeOverlay()
  overlay = document.createElement('div')
  overlay.className = 'ghost-overlay'
  overlay.style.top = `${rect.bottom + 4}px`
  overlay.style.left = `${rect.left}px`
  document.body.appendChild(overlay)
}

function removeOverlay() {
  overlay?.remove()
  overlay = null
}

function cancelStream() {
  activeCancel?.cancel()
  activeCancel = null
}

function dismiss() {
  cancelStream()
  clearTimeout(pendingTimer)
  removeOverlay()
}

function onKeyDown(e: KeyboardEvent) {
  if (!overlay) return
  // Tab in an unrelated input (e.g. the chat textarea) must not capture the
  // suggestion — only keys inside the editor count.
  const target = e.target as HTMLElement | null
  const inEditor = !!target?.closest?.('.editor-host')
  const inOtherField =
    !!target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)
  if (!inEditor && inOtherField) return
  if (e.key === 'Tab' && !accepted) {
    e.preventDefault()
    e.stopPropagation()
    accepted = true
    const text = overlay.textContent ?? ''
    dismiss()
    if (text) hooks?.insert(text)
    return
  }
  if (e.key !== 'Shift') dismiss()
}

/** Shared request builder used by the editor's ghost hook. */
export function requestGhost(context: string, onDelta: (t: string) => void): { cancel: () => void } {
  const md = getMarkdown().slice(-3000)
  return stream(
    [{ role: 'user', content: `Document so far (tail):\n\n${md}\n\nCurrent paragraph:\n\n${context}\n\nContinue.` }],
    GHOST_SYSTEM,
    onDelta,
    () => {
      activeCancel = null
      if (overlay && !overlay.textContent) dismiss()
    },
    () => dismiss(),
  )
}
