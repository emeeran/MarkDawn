import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../src/types'

/**
 * The chat store must send conversation memory (recent turns) to the model,
 * while only appending the new turns to the visible transcript.
 */

const streamCalls: { messages: ChatMessage[]; system: string }[] = []
const cancelFns: (() => void)[] = []

vi.mock('../src/ai/client', () => ({
  stream: vi.fn((messages: ChatMessage[], system: string) => {
    streamCalls.push({ messages, system })
    const cancel = vi.fn()
    cancelFns.push(cancel)
    return { cancel }
  }),
}))

vi.mock('../src/lib/tauri', () => ({
  tauri: {
    storeGet: vi.fn(async () => ({})),
    storeSet: vi.fn(async () => {}),
  },
}))

import { useChat } from '../src/stores/chat'

function completeLastReply(text: string) {
  // Simulate the stream's terminal state by flushing what send() wired up.
  const state = useChat.getState()
  state.messages = state.messages.map((m, i) =>
    i === state.messages.length - 1 ? { ...m, content: text } : m,
  )
  useChat.setState({ messages: state.messages, streaming: false, cancel: null })
}

beforeEach(() => {
  streamCalls.length = 0
  cancelFns.length = 0
  useChat.setState({ messages: [], streaming: false, cancel: null })
})

describe('chat memory', () => {
  it('sends prior turns to the model, not just the new message', () => {
    const chat = useChat.getState()
    chat.send('sys', [{ role: 'user', content: 'q1' }])
    completeLastReply('a1')

    useChat.getState().send('sys', [{ role: 'user', content: 'q2' }])
    expect(streamCalls[1].messages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
  })

  it('caps memory at the last 10 non-empty turns', () => {
    for (let i = 1; i <= 7; i++) {
      useChat.getState().send('sys', [{ role: 'user', content: `q${i}` }])
      completeLastReply(`a${i}`)
    }
    useChat.getState().send('sys', [{ role: 'user', content: 'q8' }])
    const sent = streamCalls.at(-1)!.messages
    // 7 turns × 2 messages, capped at the last 10 + the new one
    expect(sent).toHaveLength(11)
    expect(sent[0].content).toBe('q3')
    expect(sent.at(-1)!.content).toBe('q8')
  })

  it('does not duplicate history in the visible transcript', () => {
    useChat.getState().send('sys', [{ role: 'user', content: 'q1' }])
    completeLastReply('a1')
    useChat.getState().send('sys', [{ role: 'user', content: 'q2' }])
    const shown = useChat.getState().messages
    expect(shown).toHaveLength(4) // q1, a1, q2, streaming placeholder
    expect(shown.filter((m) => m.content === 'q1')).toHaveLength(1)
  })

  it('refuses to start a second stream while one is in flight', () => {
    useChat.getState().send('sys', [{ role: 'user', content: 'q1' }])
    useChat.getState().send('sys', [{ role: 'user', content: 'q2' }])
    expect(streamCalls).toHaveLength(1)
  })
})
