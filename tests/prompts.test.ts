import { describe, expect, it } from 'vitest'
import { buildTransformPrompt, TRANSFORM_PROMPTS } from '../src/ai/prompts'

describe('buildTransformPrompt', () => {
  it('builds known actions from the table', () => {
    for (const key of Object.keys(TRANSFORM_PROMPTS)) {
      const p = buildTransformPrompt(key, 'TEXT')
      expect(p).toContain('TEXT')
    }
  })

  it('translates to the requested language', () => {
    expect(buildTransformPrompt('translate', 'TEXT', 'German')).toContain('German')
    expect(buildTransformPrompt('translate', 'TEXT')).toContain('English')
  })

  it('embeds custom prompts verbatim', () => {
    expect(buildTransformPrompt('custom', 'TEXT', 'Make this rhyme')).toContain('Make this rhyme')
  })
})
