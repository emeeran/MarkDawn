import { tauri } from '../lib/tauri'
import { useSettings } from '../stores/settings'
import { useToast } from '../stores/toast'
import { getSelection } from './selection'

export type ReadMode = 'doc' | 'sel' | 'cursor'

/**
 * Extract plain text for reading aloud. Uses the rendered DOM (not raw
 * Markdown) so headings/links read naturally; in source mode it reads the
 * textarea content.
 */
export function extractText(mode: ReadMode): string {
  if (useSettings.getState().sourceMode) {
    const ta = document.querySelector<HTMLTextAreaElement>('.source-editor')
    if (!ta) return ''
    if (mode === 'doc') return ta.value
    if (mode === 'sel') return ta.value.slice(ta.selectionStart, ta.selectionEnd)
    return ta.value.slice(ta.selectionStart)
  }
  const host = document.querySelector('.editor-host')
  if (!host) return ''
  if (mode === 'doc') return (host.textContent ?? '').trim()
  if (mode === 'sel') return getSelection().text.trim()

  // From cursor: range from the caret to the end of the editor.
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.getRangeAt(0).startContainer) return ''
  const range = sel.getRangeAt(0).cloneRange()
  range.setEnd(host, host.childNodes.length)
  return range.toString().trim()
}

export async function readAloud(mode: ReadMode) {
  const text = extractText(mode)
  if (!text) {
    useToast.getState().show(mode === 'sel' ? 'Select some text first' : 'Nothing to read')
    return
  }
  const available = await tauri.ttsAvailable()
  if (!available) {
    useToast.getState().show('edge-tts is not installed — run: pip install edge-tts')
    return
  }
  const voice = useSettings.getState().ttsVoice || undefined
  void tauri
    .ttsSpeak(text, voice)
    .catch((e) => useToast.getState().show(`Read aloud: ${e}`))
}

export function stopReading() {
  void tauri.ttsStop().catch(() => {})
}
