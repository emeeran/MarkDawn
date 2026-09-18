import { describe, expect, it } from 'vitest'
import { pickCopySource } from '../src/editor/editBridge'

/**
 * Copy/cut source selection: Muya's markdown form of the selection wins, the
 * raw DOM selection is the fallback, and text selected OUTSIDE the editor
 * (chat panel, outline) must never be replaced by editor content.
 */
describe('pickCopySource', () => {
  it('prefers Muya markdown when the selection lives in the editor', () => {
    expect(pickCopySource(true, '# Title\n', 'Title')).toBe('# Title\n')
  })

  it('falls back to the DOM selection when Muya yields nothing', () => {
    expect(pickCopySource(true, '', 'plain')).toBe('plain')
  })

  it('never lets editor content shadow a selection made elsewhere', () => {
    expect(pickCopySource(false, '# doc block', 'chat text')).toBe('chat text')
  })

  it('returns empty when there is nothing to copy anywhere', () => {
    expect(pickCopySource(false, '', '')).toBe('')
  })
})
