import type { ITocItem, Muya } from '@muyajs/core'

/**
 * Single owner of all mutations into the Muya editor. Every feature (AI edits,
 * ghost text, chat inserts, find/replace) funnels through here so cursor and
 * undo regressions have exactly one place to live.
 */

let muya: Muya | null = null

export function registerMuya(m: Muya | null) {
  muya = m
}

export function getMuya(): Muya | null {
  return muya
}

export function getMarkdown(): string {
  return muya?.getMarkdown() ?? ''
}

export function setContent(markdown: string) {
  muya?.setContent(markdown)
}

/**
 * Insert plain text at the caret (replacing any selection) via the native
 * contenteditable command. Goes through Muya's DOM event handlers, so its
 * state and undo stack stay in sync.
 * ponytail: execCommand is deprecated-but-universally-supported; revisit only
 * if WebKit ever drops it.
 */
export function insertText(text: string): boolean {
  if (!muya) return false
  // muya.focus() moves the caret to the START of the document (its only
  // focus() does setCursor(0,0)), so only use it to recover a lost focus —
  // never while the caret already lives in the editor (image paste, AI
  // inserts, format wraps all arrive with the caret in place).
  const el = document.activeElement
  const focusedEntry = el instanceof HTMLElement && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
  if (focusedEntry ? !muya.domNode.contains(el) : !muya.domNode.contains(window.getSelection()?.anchorNode ?? null)) {
    muya.focus()
  }
  return document.execCommand('insertText', false, text)
}

/**
 * Insert Markdown that may span multiple blocks. Tiered strategy:
 *  1. synthetic paste event → Muya's clipboard bridge converts Markdown text
 *     into proper blocks and records undo history
 *  2. fallback: plain insertText (newlines stay inside one block)
 * Resolves to whether strategy 1 (the good one) worked.
 */
export async function insertMarkdown(markdown: string): Promise<boolean> {
  if (!muya) return false
  if (!markdown.includes('\n')) return insertText(markdown)

  const before = getMarkdown()
  const dt = new DataTransfer()
  dt.setData('text/plain', markdown)
  const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  muya.domNode.dispatchEvent(evt)
  await new Promise((r) => setTimeout(r, 50))
  if (getMarkdown() !== before) return true
  return insertText(markdown)
}

/** Replace the current DOM selection with Markdown. */
export async function replaceSelection(markdown: string): Promise<boolean> {
  return insertMarkdown(markdown)
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
