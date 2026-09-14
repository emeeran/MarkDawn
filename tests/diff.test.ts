import { describe, expect, it } from 'vitest'
import { isNoOp, wordDiff } from '../src/ai/diff'

describe('wordDiff', () => {
  it('returns no ops for identical text', () => {
    const ops = wordDiff('hello world', 'hello world')
    expect(ops).toEqual([{ type: 'same', text: 'hello world' }])
  })

  it('marks replaced words as del+add', () => {
    const ops = wordDiff('the quick fox', 'the slow fox')
    expect(ops.some((o) => o.type === 'del' && o.text.includes('quick'))).toBe(true)
    expect(ops.some((o) => o.type === 'add' && o.text.includes('slow'))).toBe(true)
    expect(ops.filter((o) => o.type === 'same').map((o) => o.text).join('')).toContain('the')
  })

  it('handles pure insertion', () => {
    const ops = wordDiff('hello', 'hello brave world')
    expect(ops.some((o) => o.type === 'add' && o.text.includes('brave'))).toBe(true)
    expect(ops.some((o) => o.type === 'del')).toBe(false)
  })

  it('handles pure deletion', () => {
    const ops = wordDiff('hello brave world', 'hello world')
    expect(ops.some((o) => o.type === 'del' && o.text.includes('brave'))).toBe(true)
    expect(ops.some((o) => o.type === 'add')).toBe(false)
  })

  it('round-trips both inputs by accumulating ops in encounter order', () => {
    const a = 'one two three four five'
    const b = 'one 2 three four 5 six'
    const ops = wordDiff(a, b)
    let aSide = ''
    let bSide = ''
    for (const op of ops) {
      if (op.type !== 'add') aSide += op.text
      if (op.type !== 'del') bSide += op.text
    }
    expect(normalize(aSide)).toBe(normalize(a))
    expect(normalize(bSide)).toBe(normalize(b))
  })

  it('merges adjacent tokens of the same type', () => {
    const ops = wordDiff('a b c', 'x y z')
    expect(ops.filter((o) => o.type === 'del')).toHaveLength(1)
    expect(ops.filter((o) => o.type === 'add')).toHaveLength(1)
  })

  it('isNoOp ignores whitespace differences', () => {
    expect(isNoOp('a  b\n', ' a b')).toBe(true)
    expect(isNoOp('a b', 'a c')).toBe(false)
  })
})

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
