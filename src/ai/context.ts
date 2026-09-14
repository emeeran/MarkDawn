import type { SelectionInfo } from '../types'

/**
 * Document context assembled for the model. Pure functions — the caller owns
 * I/O. Long docs are truncated to head+tail around the selection so the
 * selection always survives the budget cut.
 */

const FULL_DOC_BUDGET = 12_000 // chars
const AROUND_SELECTION = 2_000 // chars each side

export interface DocContext {
  doc: string
  selection: string
  outline: string
}

export function buildContext(doc: string, outline: string, selection: SelectionInfo | null): DocContext {
  const sel = selection?.text.trim() ?? ''
  let contextDoc: string
  if (doc.length <= FULL_DOC_BUDGET) {
    contextDoc = doc
  } else if (sel) {
    const idx = findSubstring(doc, sel)
    if (idx >= 0) {
      const start = Math.max(0, idx - AROUND_SELECTION)
      const end = Math.min(doc.length, idx + sel.length + AROUND_SELECTION)
      contextDoc = `[…earlier omitted…]${doc.slice(start, idx)}⟪SELECTION STARTS HERE⟫${sel}⟪SELECTION ENDS HERE⟫${doc.slice(idx + sel.length, end)}[…later omitted…]`
    } else {
      contextDoc = `${sliceMiddle(doc)}\n\n⟪The user has this text selected:⟫\n${sel}`
    }
  } else {
    contextDoc = sliceMiddle(doc)
  }
  return { doc: contextDoc, selection: sel, outline }
}

function sliceMiddle(doc: string): string {
  const half = FULL_DOC_BUDGET / 2
  return `${doc.slice(0, half)}\n\n[…middle omitted…]\n\n${doc.slice(-half)}`
}

export function findSubstring(doc: string, sub: string): number {
  const i = doc.indexOf(sub)
  return i
}
