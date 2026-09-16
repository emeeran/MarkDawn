import { getSelection } from '../ai/selection'
import { insertMarkdown, insertText } from './editBridge'

/**
 * Paragraph/Format menu actions. Line prefixes insert at the caret (correct
 * when the caret is on the line being converted — Typora converts the whole
 * paragraph, we approximate; multi-block inserts go through the paste bridge).
 * No explicit focus() here: muya's focus() moves the caret to doc start —
 * insertText re-focuses only when focus was genuinely lost.
 */

export function insertLinePrefix(prefix: string) {
  insertText(prefix)
}

export function insertBlock(markdown: string) {
  void insertMarkdown(markdown)
}

export function wrapSelection(marker: string) {
  const sel = getSelection().text
  if (sel) insertText(`${marker}${sel}${marker}`)
  else insertText(`${marker}${marker}`)
}

export function clearFormatting() {
  const sel = getSelection().text
  if (!sel) return
  insertText(sel.replace(/(\*\*|__|\*|_|~~|`|==)/g, ''))
}

export const PARAGRAPH_ACTIONS: Record<string, () => void> = {
  'para.h1': () => insertLinePrefix('# '),
  'para.h2': () => insertLinePrefix('## '),
  'para.h3': () => insertLinePrefix('### '),
  'para.h4': () => insertLinePrefix('#### '),
  'para.h5': () => insertLinePrefix('##### '),
  'para.h6': () => insertLinePrefix('###### '),
  'para.quote': () => insertLinePrefix('> '),
  'para.ol': () => insertLinePrefix('1. '),
  'para.ul': () => insertLinePrefix('- '),
  'para.task': () => insertLinePrefix('- [ ] '),
  'para.hr': () => insertBlock('\n---\n'),
  'para.code': () => insertBlock('\n```\n\n```\n'),
  'para.math': () => insertBlock('\n$$\n\n$$\n'),
  'para.table': () =>
    insertBlock('\n| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n|          |          |          |\n|          |          |          |\n'),
}

export const FORMAT_ACTIONS: Record<string, () => void> = {
  'fmt.bold': () => wrapSelection('**'),
  'fmt.italic': () => wrapSelection('*'),
  'fmt.code': () => wrapSelection('`'),
  'fmt.strike': () => wrapSelection('~~'),
  'fmt.clear': clearFormatting,
}
