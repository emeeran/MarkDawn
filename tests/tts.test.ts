import { describe, expect, it } from 'vitest'
import { chunkForSpeech, stripMarkdown } from '../src/ai/tts'

describe('stripMarkdown', () => {
  it('strips emphasis, headings, and quotes', () => {
    expect(stripMarkdown('# Title\n\n**bold** and *ital* and ~~gone~~')).toBe(
      'Title\n\nbold and ital and gone',
    )
    expect(stripMarkdown('> quoted words')).toBe('quoted words')
  })

  it('keeps link text and image alt, drops URLs', () => {
    expect(stripMarkdown('see [the docs](https://x.com/a) now')).toBe('see the docs now')
    expect(stripMarkdown('![a cat](img/cat.png) sits')).toBe('a cat sits')
  })

  it('drops code fences but keeps inline code content', () => {
    expect(stripMarkdown('```\nconst x = 1\n```')).not.toContain('```')
    expect(stripMarkdown('run `npm test` twice')).toBe('run npm test twice')
  })

  it('strips list markers, hr, and table pipes', () => {
    expect(stripMarkdown('- one\n- two')).toBe('one\ntwo')
    expect(stripMarkdown('1. first\n2. second')).toBe('first\nsecond')
    expect(stripMarkdown('---\n')).toBe('')
    expect(stripMarkdown('| a | b |')).not.toContain('|')
  })
})

describe('chunkForSpeech', () => {
  it('splits on sentence terminators followed by whitespace, keeping offsets', () => {
    const text = 'First one. Second one! Third?'
    const chunks = chunkForSpeech(text)
    expect(chunks.map((c) => text.slice(c.start, c.end))).toEqual([
      'First one.',
      ' Second one!',
      ' Third?',
    ])
  })

  it('does not split abbreviations or decimals', () => {
    const chunks = chunkForSpeech('It costs 3.14 dollars etc. Next')
    expect(chunks).toHaveLength(2)
    expect(chunks[0].speak).toContain('3.14')
  })

  it('splits on newlines', () => {
    expect(chunkForSpeech('para one\n\npara two')).toHaveLength(2)
  })

  it('hard-splits runs longer than maxLen', () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkForSpeech(long, 500)
    expect(chunks.length).toBeGreaterThan(2)
    chunks.forEach((c) => expect(c.speak.length).toBeLessThanOrEqual(510))
    // Chunk offsets must span the whole text for highlighting to stay in sync.
    expect(chunks[0].start).toBe(0)
    expect(chunks[chunks.length - 1].end).toBe(long.length)
  })

  it('drops empty chunks but keeps offsets of speakable ones', () => {
    const text = '# Heading\n\nReal sentence.'
    const chunks = chunkForSpeech(text)
    expect(chunks.every((c) => c.speak.length > 0)).toBe(true)
    const real = chunks[chunks.length - 1]
    expect(text.slice(real.start, real.end)).toBe('Real sentence.')
  })
})
