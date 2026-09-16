import { captureRange, getSelection } from './selection'
import { useToast } from '../stores/toast'

/**
 * Entry point for "transform the selection" actions from anywhere
 * (selection action bar, right-click menu, command palette, shortcuts). The
 * App component listens for this event and shows the diff popover. The DOM
 * range is frozen HERE — before any popover UI can steal focus/collapse the
 * selection — so Apply can re-target the exact original span.
 */
export function runSelectionTransform(action: string, extra?: string): boolean {
  const sel = getSelection()
  if (!sel.text.trim()) {
    useToast.getState().show('Select some text first')
    return false
  }
  window.dispatchEvent(
    new CustomEvent('notepad:transform', { detail: { action, extra, range: captureRange() } }),
  )
  return true
}
