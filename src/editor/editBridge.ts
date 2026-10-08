import type { ITocItem, Muya } from '@muyajs/core'
import { restoreRange } from '../ai/selection'

/**
 * Single owner of all mutations into the Muya editor. Every feature (AI edits,
 * ghost text, chat inserts, find/replace) funnels through here so cursor and
 * undo regressions have exactly one place to live.
 */

let muya: Muya | null = null

export function registerMuya(m: Muya | null) {
  muya = m
}

// MuyaEditor registers a flush for its pending debounced emit. Store actions
// that read or destroy tab state (tab close, tab switch, quit) call
// flushPendingEmit() FIRST — otherwise keystrokes in the last 80ms of the
// debounce window never reach the store and are lost.
let flushPending: (() => void) | null = null

export function registerEmitFlush(fn: (() => void) | null) {
  flushPending = fn
}

export function flushPendingEmit() {
  flushPending?.()
}

export function getMuya(): Muya | null {
  return muya
}

export function getMarkdown(): string {
  return plainTa()?.value ?? muya?.getMarkdown() ?? ''
}

/** The raw textarea (source mode / plain text tab) when it is the live editor. */
function plainTa(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('.source-editor')
}

/**
 * Insert into the plain textarea. execCommand keeps the native undo stack
 * (same deprecated-but-universal trick as the muya path); setRangeText is the
 * fallback when a WebKit refuses — it skips undo but the text still lands and
 * the synthetic input event feeds React → store → autosave.
 */
function taInsert(ta: HTMLTextAreaElement, text: string, start: number, end: number): boolean {
  ta.focus()
  ta.setSelectionRange(start, end)
  if (document.execCommand('insertText', false, text)) return true
  ta.setRangeText(text, start, end, 'end')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

export function setContent(markdown: string) {
  muya?.setContent(markdown)
}

/**
 * Recover editor focus if it drifted, then pin the exact target range.
 * muya.focus() moves the caret to the START of the document (its only
 * focus() does setCursor(0,0)), so a captured range must be re-added AFTER
 * any focus call — this ordering is what makes deferred applies land right.
 * Returns false when a supplied range is STALE: its nodes belong to a
 * document that is no longer mounted (tab switch while an AI edit streamed).
 * Applying it would insert into whatever the live caret points at — another
 * tab's file — so callers must abort instead.
 */
function focusAndRetarget(range?: Range | null): boolean {
  if (!muya) return false
  if (range && (!range.startContainer.isConnected || !muya.domNode.contains(range.startContainer))) {
    return false
  }
  const el = document.activeElement
  const focusedEntry = el instanceof HTMLElement && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
  if (focusedEntry ? !muya.domNode.contains(el) : !muya.domNode.contains(window.getSelection()?.anchorNode ?? null)) {
    muya.focus()
  }
  restoreRange(range ?? null)
  return true
}

/**
 * Insert plain text at the caret (replacing any selection) via the native
 * contenteditable command. Goes through Muya's DOM event handlers, so its
 * state and undo stack stay in sync.
 * ponytail: execCommand is deprecated-but-universally-supported; revisit only
 * if WebKit ever drops it.
 */
export function insertText(text: string, range?: Range | null): boolean {
  const ta = plainTa()
  if (ta) return taInsert(ta, text, ta.selectionStart, ta.selectionEnd)
  if (!muya) return false
  // Never focus while the caret already lives in the editor (image paste, AI
  // inserts, format wraps all arrive with the caret in place).
  if (!focusAndRetarget(range)) return false
  return document.execCommand('insertText', false, text)
}

/**
 * Insert Markdown that may span multiple blocks. Tiered strategy:
 *  1. synthetic paste event → Muya's clipboard bridge converts Markdown text
 *     into proper blocks and records undo history
 *  2. fallback: plain insertText (newlines stay inside one block)
 * Resolves to whether strategy 1 (the good one) worked.
 */
export async function insertMarkdown(markdown: string, range?: Range | null): Promise<boolean> {
  if (!muya) return false
  if (!markdown.includes('\n')) return insertText(markdown, range)

  // Muya's paste handler maps the LIVE DOM selection onto its blocks (and
  // cut+reinserts for multi-block targets), so pin the captured range first.
  // A stale range aborts here — the fallback below must never fire for it,
  // or the text lands at the live caret of whatever tab is now mounted.
  if (!focusAndRetarget(range)) return false
  const before = getMarkdown()
  const dt = new DataTransfer()
  dt.setData('text/plain', markdown)
  const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  muya.domNode.dispatchEvent(evt)
  await new Promise((r) => setTimeout(r, 50))
  if (getMarkdown() !== before) return true
  return insertText(markdown)
}

/** Replace the given (or current) DOM selection with Markdown. */
export async function replaceSelection(markdown: string, range?: Range | null): Promise<boolean> {
  if (plainTa()) return insertText(markdown)
  return insertMarkdown(markdown, range)
}

/**
 * Replace an exact [start,end) span of the plain textarea — the Apply path for
 * AI diffs in plain text mode (a DOM Range is meaningless over a textarea).
 * Guarded: the span must still hold the text that was selected when the action
 * fired, or the edit is aborted (tab switched under the popover, etc.).
 */
export function replacePlainSpan(
  text: string,
  span: { start: number; end: number; text: string },
): boolean {
  const ta = plainTa()
  if (!ta) return false
  if (ta.value.slice(span.start, span.end) !== span.text) return false
  return taInsert(ta, text, span.start, span.end)
}

/** Which clipboard text a copy/cut should yield: Muya's markdown form of the
 *  selection wins, the raw DOM selection is the fallback (e.g. right after a
 *  programmatic select-all, before Muya's model resyncs), and text selected
 *  OUTSIDE the editor (chat panel, outline) must never be shadowed by it. */
export function pickCopySource(inEditor: boolean, muyaText: string, selText: string): string {
  return (inEditor ? muyaText : '') || selText
}

/**
 * Copy/cut support for the menu/keyboard bridge. The clipboard text comes from
 * Muya's own clipboard controller — the Markdown form of the current
 * selection. A synthetic 'cut' event is still dispatched for its DELETE
 * side-effect (Muya's history-tracked cutHandler); clipboardData cannot be
 * carried on synthetic ClipboardEvents (WebKit drops the init), so the text
 * is read directly instead. Empty string = Muya had no selection to work with.
 */
export function muyaClipboardCopyCut(op: 'copy' | 'cut'): string {
  if (!muya) return ''
  const { text } = muya.editor.clipboard.getClipboardData()
  if (op === 'cut') {
    muya.domNode.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true }))
  }
  return text
}

/** Select the whole editor document (Ctrl+A / menu Select All). Goes through
 *  Muya's own select-all so its MODEL selection is set — a raw DOM
 *  selectNodeContents leaves Muya unaware, and its cut/copy handlers then
 *  silently no-op (Ctrl+X after Ctrl+A deleted nothing). */
export function selectAllInEditor(): boolean {
  if (!muya) return false
  const selection = muya.editor.selection
  selection.selectAll()
  // From a collapsed caret Muya selects just the current block (Typora-style
  // progressive select) — widen to the whole document in the same keystroke.
  const sel = selection.getSelection()
  if (sel && sel.anchorBlock === sel.focusBlock) selection.selectAll()
  return true
}

// --- find/replace (thin wrappers over Muya's built-in engine) ---

export interface FindOpts {
  isRegexp?: boolean
  isCaseSensitive?: boolean
  isWholeWord?: boolean
}

export function search(value: string, opts: FindOpts = {}) {
  muya?.search(value, opts)
}

export function findNext() {
  muya?.find('next')
}

export function findPrevious() {
  muya?.find('previous')
}

export function replace(value: string, opts: { isSingle?: boolean; isRegexp?: boolean } = {}) {
  muya?.replace(value, { isSingle: opts.isSingle ?? true, isRegexp: opts.isRegexp ?? false })
}

export function replaceAll(value: string, opts: { isRegexp?: boolean } = {}) {
  muya?.replace(value, { isSingle: false, isRegexp: opts.isRegexp ?? false })
}

export function getTOC(): ITocItem[] {
  return muya?.getTOC() ?? []
}
