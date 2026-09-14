import { tauri } from '../lib/tauri'
import { useSettings } from '../stores/settings'
import type { ChatMessage } from '../types'

export interface StreamHandle {
  cancel: () => void
}

/**
 * Start a streaming completion using the configured provider/model.
 * `onError` fires once; `onDelta` fires per token chunk.
 */
export function stream(
  messages: ChatMessage[],
  system: string,
  onDelta: (text: string) => void,
  onDone: () => void,
  onError: (message: string) => void,
): { cancel: () => void } {
  const { provider, models, ollamaUrl } = useSettings.getState()
  const cancel = tauri.aiStream(
    { provider, model: models[provider], system, messages, ollamaUrl },
    (e) => {
      if (e.type === 'delta') onDelta(e.text)
      else if (e.type === 'done') onDone()
      else onError(e.message)
    },
  )
  return { cancel }
}

export async function isProviderConfigured(provider = useSettings.getState().provider): Promise<boolean> {
  if (provider === 'ollama') return true // zero-config; errors surface at request time
  const status = await tauri.secretStatus()
  return status[provider] === true
}
