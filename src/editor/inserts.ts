import { getSelection } from '../ai/selection'
import { getMuya, insertMarkdown, insertText } from './editBridge'

/**
 * Paragraph/Format menu actions. Line prefixes insert at the caret (correct
 * when the caret is on the line being converted — Typora converts the whole
 * paragraph, we approximate; multi-block inserts go through the paste bridge).
 */

function focusEditor() {
  getMuya()?.focus()
}

export function insertLinePrefix(prefix: string) {
  focusEditor()
  insertText(prefix)
}

export function insertBlock(markdown: string) {
  focusEditor()
  void insertMarkdown(markdown)
}

export function wrapSelection(marker: string) {
  focusEditor()
  const sel = getSelection().text
  if (sel) insertText(`${marker}${sel}${marker}`)
  else insertText(`${marker}${marker}`)
}

export function clearFormatting() {
  focusEditor()
  const sel = getSelection().text
  if (!sel) return
  insertText(sel.replace(/(\*\*|__|\*|_|~~|`|==)/g, ''))
}

export const PARAGRAAPH_ACTIONS: Record<string, () => void> = {
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
