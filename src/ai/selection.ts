import type { SelectionInfo } from '../types'

/**
 * Live selection state kept outside React so 60fps selection changes never
 * re-render the tree. Consumers read it on demand; the editor pushes updates.
 */
let current: SelectionInfo = { text: '', rect: null }

export function setSelection(info: SelectionInfo) {
  current = info
}

export function getSelection(): SelectionInfo {
  return current
}

export function readDomSelection(): SelectionInfo {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return { text: '', rect: null }
  }
  const range = sel.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  return {
    text: sel.toString(),
    rect:
      rect.width || rect.height
        ? { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right }
        : null,
  }
}

/**
 * Freeze the live DOM selection so a deferred edit (streaming AI diff) can
 * re-target the exact range later, even if the live selection collapses in
 * between. Cloned — a live Range would silently follow DOM mutations.
 */
export function captureRange(): Range | null {
  const sel = window.getSelection()
  return sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
}

export function restoreRange(range: Range | null): boolean {
  if (!range) return false
  const sel = window.getSelection()
  if (!sel) return false
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}
