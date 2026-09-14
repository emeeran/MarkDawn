import { describe, expect, it } from 'vitest'
import { NON_CHAT_MODEL } from '../src/stores/settings'
import { DEFAULT_SETTINGS } from '../src/types'

/**
 * NON_CHAT_MODEL migrates stored models that can't stream chat.
 * It must match the Rust-side is_chat_model term list exactly.
 */
describe('NON_CHAT_MODEL filter', () => {
  it('accepts chat models', () => {
    expect(NON_CHAT_MODEL.test('llama-3.3-70b-versatile')).toBe(false)
    expect(NON_CHAT_MODEL.test('gpt-5.2')).toBe(false)
    expect(NON_CHAT_MODEL.test('claude-sonnet-5')).toBe(false)
  })

  it('rejects every family the Rust side rejects', () => {
    for (const model of [
      'meta-llama/llama-prompt-guard-2-22m',
      'whisper-large-v3',
      'playai-tts',
      'text-embedding-3-small',
      'rerank-v3.5',
      'safety-classifier-x',
      'dall-e-3',
    ]) {
      expect(NON_CHAT_MODEL.test(model)).toBe(true)
    }
  })

  it('migration in load() resets non-chat models to the default', async () => {
    const { tauri } = await import('../src/lib/tauri')
    tauri.settingsGet = async () => ({
      ...DEFAULT_SETTINGS,
      models: { ...DEFAULT_SETTINGS.models, groq: 'llama-prompt-guard-2' },
    })
    const { useSettings } = await import('../src/stores/settings')
    await useSettings.getState().load()
    expect(useSettings.getState().models.groq).toBe(DEFAULT_SETTINGS.models.groq)
  })
})
