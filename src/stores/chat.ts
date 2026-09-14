import { create } from 'zustand'
import { stream } from '../ai/client'
import { tauri } from '../lib/tauri'
import type { ChatMessage } from '../types'

const STORE = 'chat-history'

interface ChatStore {
  messages: ChatMessage[]
  streaming: boolean
  cancel: (() => void) | null
  load: () => Promise<void>
  send: (system: string, messages: ChatMessage[], onDone?: (full: string) => void) => void
  clear: () => void
}

/** Persist after every terminal state so history survives restarts. */
function persist(messages: ChatMessage[]) {
  void tauri.storeSet(STORE, { messages }).catch(() => {})
}

export const useChat = create<ChatStore>((setState, get) => ({
  messages: [],
  streaming: false,
  cancel: null,

  async load() {
    try {
      const stored = await tauri.storeGet(STORE)
      const messages = (stored as { messages?: ChatMessage[] }).messages
      if (Array.isArray(messages)) setState({ messages })
    } catch {
      /* fresh install */
    }
  },

  send(system, messages, onDone) {
    if (get().streaming) return
    // Conversation memory: the model sees recent turns, the UI already shows
    // them, so only the new messages are appended to the transcript.
    const history = get()
      .messages.filter((m) => m.content.trim())
      .slice(-10)
    setState((s) => ({
      messages: [...s.messages, ...messages, { role: 'assistant', content: '' }],
      streaming: true,
    }))
    const cancel = stream(
      [...history, ...messages],
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
        const msgs = full.trim() ? get().messages : get().messages.slice(0, -1)
        if (!full.trim()) setState({ messages: msgs })
        persist(msgs)
        onDone?.(full)
      },
      (message) => {
        setState((s) => {
          const msgs = [...s.messages]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant') {
            msgs[msgs.length - 1] = { ...last, content: `⚠ ${message}` }
          }
          persist(msgs)
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
          const msgs = empty ? s.messages.slice(0, -1) : s.messages
          persist(msgs)
          return { streaming: false, cancel: null, messages: msgs }
        })
      },
    })
  },

  clear() {
    get().cancel?.()
    setState({ messages: [], streaming: false, cancel: null })
    persist([])
  },
}))
