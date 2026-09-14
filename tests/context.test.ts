import { describe, expect, it } from 'vitest'
import { buildContext } from '../src/ai/context'

describe('buildContext', () => {
  it('returns the whole short doc untouched', () => {
    const ctx = buildContext('# Title\n\nShort body.', '', null)
    expect(ctx.doc).toBe('# Title\n\nShort body.')
    expect(ctx.selection).toBe('')
  })

  it('truncates long docs to head+tail with an omission marker', () => {
    const doc = `${'a'.repeat(10_000)}${'b'.repeat(10_000)}`
    const ctx = buildContext(doc, '', null)
    expect(ctx.doc).toContain('…middle omitted…')
    expect(ctx.doc.length).toBeLessThan(doc.length)
    expect(ctx.doc.startsWith('a'.repeat(100))).toBe(true)
    expect(ctx.doc.endsWith('b'.repeat(100))).toBe(true)
  })

  it('centers long docs around the selection and marks it', () => {
    const head = 'x'.repeat(9_000)
    const sel = 'SELECTED TEXT HERE'
    const tail = 'y'.repeat(9_000)
    const doc = `${head}${sel}${tail}`
    const ctx = buildContext(doc, '', { text: ` ${sel} `, rect: null })
    expect(ctx.doc).toContain('⟪SELECTION STARTS HERE⟫SELECTED TEXT HERE⟪SELECTION ENDS HERE⟫')
    expect(ctx.doc).toContain('…earlier omitted…')
    expect(ctx.selection).toBe(sel)
  })

  it('falls back to appending the selection when it cannot be located', () => {
    const doc = 'z'.repeat(20_000)
    const ctx = buildContext(doc, '', { text: 'not in the doc', rect: null })
    expect(ctx.doc).toContain('The user has this text selected')
    expect(ctx.doc).toContain('not in the doc')
  })
})
