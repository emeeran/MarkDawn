import { describe, expect, it } from 'vitest'
import {
  AI_FEATURES,
  buildTransformPrompt,
  featureEnabled,
  QUICK_ACTIONS,
  REPORT_PROMPTS,
  TRANSFORM_PROMPTS,
} from '../src/ai/prompts'

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

describe('AI_FEATURES registry', () => {
  // Features without a prompt here are special-cased in the command registry.
  const SPECIAL = new Set(['translate', 'custom', 'continue', 'draft'])

  it('gives every feature a unique id and a runner path', () => {
    const ids = AI_FEATURES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const f of AI_FEATURES) {
      if (SPECIAL.has(f.id)) continue
      expect(TRANSFORM_PROMPTS[f.id] ?? REPORT_PROMPTS[f.id], `runner for ${f.id}`).toBeTypeOf('function')
    }
  })

  it('exposes exactly the bar features in the selection action bar', () => {
    expect(QUICK_ACTIONS).toEqual(AI_FEATURES.filter((f) => f.bar).map(({ id, label }) => ({ id, label })))
  })

  it('defaults every feature to enabled', () => {
    for (const f of AI_FEATURES) expect(f.def).toBe(true)
  })
})

describe('featureEnabled', () => {
  it('treats absent as on and explicit false as off', () => {
    expect(featureEnabled({}, 'tone')).toBe(true)
    expect(featureEnabled({ tone: true }, 'tone')).toBe(true)
    expect(featureEnabled({ tone: false }, 'tone')).toBe(false)
  })
})
