import { tauri } from '../lib/tauri'
import { useSettings } from '../stores/settings'
import { useToast } from '../stores/toast'

export type ReadMode = 'doc' | 'sel' | 'cursor'

/** Where reading starts and the untrimmed text it covers, so sentence chunks
 *  can be mapped back onto the editor for highlighting. */
type ReadTarget =
  | { kind: 'source'; ta: HTMLTextAreaElement; text: string; base: number }
  | { kind: 'rich'; host: HTMLElement; text: string; base: number }

interface Chunk {
  start: number // offsets into ReadTarget.text
  end: number
  speak: string // markdown-free text sent to edge-tts
}

/** True while a read-aloud session is driving the editor selection. */
let reading = false
/** Bumped by stop/new read; an in-flight loop aborts when its token goes stale. */
let readToken = 0

export function isReading(): boolean {
  return reading
}

export function stopReading() {
  readToken++
  reading = false
  void tauri.ttsStop().catch(() => {})
}

/** Offset of `r`'s start within host.textContent (prefix-length trick). */
function offsetOf(host: HTMLElement, r: Range): number {
  const pre = document.createRange()
  pre.selectNodeContents(host)
  pre.setEnd(r.startContainer, r.startOffset)
  return pre.toString().length
}

function readTarget(mode: ReadMode): ReadTarget | null {
  if (useSettings.getState().sourceMode) {
    const ta = document.querySelector<HTMLTextAreaElement>('.source-editor')
    if (!ta) return null
    if (mode === 'doc') return { kind: 'source', ta, text: ta.value, base: 0 }
    return {
      kind: 'source',
      ta,
      text: ta.value.slice(ta.selectionStart, mode === 'sel' ? ta.selectionEnd : ta.value.length),
      base: ta.selectionStart,
    }
  }
  const host = document.querySelector<HTMLElement>('.editor-host')
  if (!host) return null
  if (mode === 'doc') return { kind: 'rich', host, text: host.textContent ?? '', base: 0 }
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || (mode === 'sel' && sel.isCollapsed)) return null
  const range = sel.getRangeAt(0)
  if (mode === 'sel') {
    return { kind: 'rich', host, text: sel.toString(), base: offsetOf(host, range) }
  }
  // From cursor: range from the caret to the end of the editor.
  const rest = document.createRange()
  rest.selectNodeContents(host)
  rest.setStart(range.startContainer, range.startOffset)
  return { kind: 'rich', host, text: rest.toString(), base: offsetOf(host, range) }
}

/**
 * Remove markdown syntax so signs aren't spoken. Chunks carry original-text
 * offsets for highlighting, so this only cleans what edge-tts says.
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/^\s*(```|~~~).*$/gm, '') // fenced code fences
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link → text
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1') // reference link → text
    .replace(/`([^`]*)`/g, '$1') // inline code ticks
    .replace(/^#{1,6}\s+/gm, '') // heading markers
    .replace(/^>\s?/gm, '') // blockquote markers
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '') // list markers
    .replace(/(\*\*\*|\*\*|__|\*|_|~~)/g, '') // emphasis markers
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '') // horizontal rules
    .replace(/<\/?[a-z][^>]*>/gi, '') // raw HTML tags
    .replace(/\|/g, ' ') // table pipes
}

/** Sentence-ish chunks with offsets kept for highlighting. */
export function chunkForSpeech(text: string, maxLen = 500): Chunk[] {
  const out: Chunk[] = []
  let start = 0
  const at = (k: number) => text[k] ?? ''
  const push = (end: number) => {
    const speak = stripMarkdown(text.slice(start, end)).trim()
    if (speak) out.push({ start, end, speak })
    start = end
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    // ". — end of sentence only when followed by optional close-quote + space/EOL,
    // so "e.g.", "U.S.A", "3.14" stay in one chunk.
    const terminated =
      '.!?…'.includes(ch) &&
      (() => {
        let k = i + 1
        if ('"\')]'.includes(at(k))) k++
        return k >= text.length || /\s/.test(at(k))
      })()
    // Very long runs (code, tables, base64) split at the last space, then anywhere.
    const tooLong = i - start >= maxLen * 2 || (i - start >= maxLen && ch === ' ')
    if (ch === '\n' || terminated || tooLong) push(i + 1)
  }
  if (start < text.length) push(text.length)
  return out
}

/** Highlight the chunk: native textarea selection, or a DOM selection over the
 *  rendered editor. Read-only — no editor content is touched. */
function highlight(t: ReadTarget, c: Chunk) {
  if (t.kind === 'source') {
    t.ta.setSelectionRange(t.base + c.start, t.base + c.end)
    return
  }
  const range = document.createRange()
  const walker = document.createTreeWalker(t.host, NodeFilter.SHOW_TEXT)
  let pos = 0
  let placedStart = false
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = (node as Text).data.length
    if (!placedStart && pos + len >= c.start + t.base) {
      range.setStart(node, Math.max(0, c.start + t.base - pos))
      placedStart = true
    }
    if (placedStart && pos + len >= c.end + t.base) {
      range.setEnd(node, c.end + t.base - pos)
      break
    }
    pos += len
  }
  if (!placedStart) return // offsets drifted (DOM changed) — keep reading silently
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  range.startContainer.parentElement?.scrollIntoView({ block: 'nearest' })
}

export async function readAloud(mode: ReadMode) {
  const target = readTarget(mode)
  if (!target || !target.text.trim()) {
    useToast.getState().show(mode === 'sel' ? 'Select some text first' : 'Nothing to read')
    return
  }
  const available = await tauri.ttsAvailable()
  if (!available) {
    useToast.getState().show('edge-tts is not installed — run: pip install edge-tts')
    return
  }
  const s = useSettings.getState()
  const synth = (c: Chunk) => {
    const p = tauri.ttsSynth(c.speak, s.ttsVoice || undefined, s.ttsRate, s.ttsPitch, s.ttsVolume)
    p.catch(() => {}) // Stop kills a prefetch mid-flight; don't leak a rejection
    return p
  }
  const play = (mp3: string) => tauri.ttsPlay(mp3)

  const token = ++readToken
  reading = true
  useToast.getState().show('Reading aloud — Ctrl+Alt+S stops')
  await tauri.ttsStop().catch(() => {}) // cut off any playback from a stale read
  try {
    const chunks = chunkForSpeech(target.text)
    if (chunks.length === 0) return
    // Prefetch: the next sentence synthesizes while the current one plays, so
    // there's no synth pause between sentences.
    let pending = synth(chunks[0])
    for (let i = 0; i < chunks.length; i++) {
      if (token !== readToken) return
      const mp3 = await pending
      if (i + 1 < chunks.length) pending = synth(chunks[i + 1])
      highlight(target, chunks[i])
      const player = await play(mp3)
      if (token !== readToken) return
      if (player === 'xdg-open') {
        // xdg-open hands the file to the desktop and exits immediately — it
        // can't pace sentence-by-sentence, so read the remainder in one shot.
        const rest = target.text.slice(chunks[i].end)
        const speakable = stripMarkdown(rest).trim()
        if (speakable) {
          const whole = { start: chunks[i].end, end: target.text.length, speak: speakable }
          highlight(target, whole)
          await play(await synth(whole))
        }
        return
      }
    }
  } catch (e) {
    if (!String(e).includes('stopped')) {
      useToast.getState().show(`Read aloud: ${e instanceof Error ? e.message : String(e)}`)
    }
  } finally {
    if (token === readToken) {
      readToken++ // natural end: invalidate self so isReading() clears
      reading = false
    }
  }
}
