import { create } from 'zustand'
import { stream } from '../ai/client'
import type { ChatMessage } from '../types'

interface ChatStore {
  messages: ChatMessage[]
  streaming: boolean
  cancel: (() => void) | null
  send: (system: string, messages: ChatMessage[], onDone?: (full: string) => void) => void
  clear: () => void
}

export const useChat = create<ChatStore>((setState, get) => ({
  messages: [],
  streaming: false,
  cancel: null,

  send(system, messages, onDone) {
    if (get().streaming) return
    setState((s) => ({
      messages: [...s.messages, ...messages, { role: 'assistant', content: '' }],
      streaming: true,
    }))
    const cancel = stream(
      messages,
      system,
      (delta) => {
        setState((s) => {
          const msgs = [...s.messages]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant') msgs[msgs.length - 1] = { ...last, content: last.content + delta }
          return { messages: msgs }
        })
      },
      () => {
        const full = get().messages.at(-1)?.content ?? ''
        setState({ streaming: false, cancel: null })
        // Drop an empty assistant bubble (e.g. cancelled before first token).
        if (!full.trim()) {
          setState((s) => ({ messages: s.messages.slice(0, -1) }))
        }
        onDone?.(full)
      },
      (message) => {
        setState((s) => {
          const msgs = [...s.messages]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, content: `⚠ ${message}` }
          }
          return { messages: msgs, streaming: false, cancel: null }
        })
      },
    )
    setState({
      cancel: () => {
        cancel.cancel()
        // The Rust task is aborted without sending Done; reset locally and
        // drop an assistant bubble that never received a token.
        setState((s) => {
          const last = s.messages.at(-1)
          const empty = last?.role === 'assistant' && !last.content.trim()
          return { streaming: false, cancel: null, messages: empty ? s.messages.slice(0, -1) : s.messages }
        })
      },
    })
  },

  clear() {
    get().cancel?.()
    setState({ messages: [], streaming: false, cancel: null })
  },
}))
