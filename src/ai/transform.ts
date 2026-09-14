import { getSelection } from './selection'
import { useToast } from '../stores/toast'

/**
 * Entry point for "transform the selection" actions from anywhere
 * (selection action bar, command palette, shortcuts). The App component
 * listens for this event and shows the diff popover.
 */
export function runSelectionTransform(action: string, extra?: string): boolean {
  const sel = getSelection()
  if (!sel.text.trim()) {
    useToast.getState().show('Select some text first')
    return false
  }
  window.dispatchEvent(new CustomEvent('notepad:transform', { detail: { action, extra } }))
  return true
}
