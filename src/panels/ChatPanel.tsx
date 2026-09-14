import { useEffect, useRef, useState } from 'react'
import { renderToStaticHTML } from '@muyajs/core'
import { isProviderConfigured } from '../ai/client'
import { buildContext } from '../ai/context'
import { BASE_SYSTEM, DOC_CHAT_TEMPLATE } from '../ai/prompts'
import { getSelection } from '../ai/selection'
import { getMarkdown, getTOC, insertText, replaceSelection } from '../editor/editBridge'
import { tauri } from '../lib/tauri'
import { useChat } from '../stores/chat'
import { useSettings } from '../stores/settings'
import { useToast } from '../stores/toast'
import { useWorkspace } from '../stores/workspace'

type CtxMode = 'document' | 'selection' | 'none'

export function ChatPanel() {
  const { messages, streaming, send, clear, cancel } = useChat()
  const settings = useSettings()
  const workspace = useWorkspace()
  const [input, setInput] = useState('')
  const [ctxMode, setCtxMode] = useState<CtxMode>('document')
  const [hasKey, setHasKey] = useState(true)
  const [notepad, setNotepad] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void isProviderConfigured().then(setHasKey)
  }, [settings.provider])

  useEffect(() => {
    if (!workspace.root) {
      setNotepad(null)
      return
    }
    let gone = false
    void (async () => {
      const path = await tauri.pathJoin(workspace.root!, 'NOTEPAD.md')
      const md = await tauri.readFile(path).catch(() => null)
      if (!gone) setNotepad(md)
    })()
    return () => {
      gone = true
    }
  }, [workspace.root])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [messages])

  function send2() {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')

    let system = BASE_SYSTEM
    if (notepad) system += `\n\nThe user's writing instructions (NOTEPAD.md):\n${notepad}`

    const sel = getSelection()
    const msgs: { role: 'user' | 'assistant'; content: string }[] = []
    if (ctxMode === 'document') {
      const outline = getTOC()
        .map((t) => `${'  '.repeat(Math.max(0, t.lvl - 1))}- ${t.content}`)
        .join('\n')
      const ctx = buildContext(getMarkdown(), outline, sel.text ? sel : null)
      let payload = ctx.selection
        ? `${ctx.doc}\n\nThe user is working with this selected text: ${ctx.selection}`
        : ctx.doc
      if (ctx.outline) payload += `\n\nDocument outline:\n${ctx.outline}`
      msgs.push({ role: 'user', content: `${DOC_CHAT_TEMPLATE(payload)}\n\n${text}` })
    } else if (ctxMode === 'selection' && sel.text.trim()) {
      msgs.push({ role: 'user', content: `Selected text:\n\n${sel.text}\n\n${text}` })
    } else {
      msgs.push({ role: 'user', content: text })
    }
    // Prior turns ride along from the chat store — the "conversation" actually
    // is one.
    send(system, msgs)
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>AI Chat</span>
        <span className="chat-model">{settings.provider}:{settings.models[settings.provider]}</span>
        <button title="Clear conversation" onClick={clear}>🗑</button>
      </div>

      {!hasKey && settings.provider !== 'ollama' && (
        <div
          className="chat-warn"
          onClick={() => window.dispatchEvent(new CustomEvent('notepad:open-settings'))}
          role="button"
        >
          No API key for {settings.provider}. Open Settings (⌘,) to add one.
        </div>
      )}

      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            Ask about the document, or select text in the editor for targeted transforms.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.role === 'assistant' ? (
              <>
                <div className="chat-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
                {m.content && !streaming && i === messages.length - 1 && (
                  <div className="chat-msg-actions">
                    <button onClick={() => void insertText(m.content)}>Insert at cursor</button>
                    <button
                      onClick={() => {
                        // Selection is read at click time — a render-time check
                        // went stale the moment the caret moved.
                        if (!getSelection().text.trim()) {
                          useToast.getState().show('Select some text first')
                          return
                        }
                        void replaceSelection(m.content).then((ok) => {
                          if (!ok) useToast.getState().show('Could not apply edit')
                        })
                      }}
                    >
                      Replace selection
                    </button>
                    <button onClick={() => void navigator.clipboard.writeText(m.content)}>Copy</button>
                  </div>
                )}
              </>
            ) : (
              <div className="chat-user-text">{m.content.length > 600 ? `…${m.content.slice(-600)}` : m.content}</div>
            )}
          </div>
        ))}
        {streaming && <div className="chat-typing">▍</div>}
      </div>

      <div className="chat-input-row">
        <select value={ctxMode} onChange={(e) => setCtxMode(e.target.value as CtxMode)} title="Context sent to the model">
          <option value="document">Doc</option>
          <option value="selection">Selection</option>
          <option value="none">None</option>
        </select>
        {notepad && <span className="chat-chip" title={notepad}>NOTEPAD.md</span>}
        <textarea
          rows={2}
          placeholder="Ask… (Enter to send, ⇧Enter for newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send2()
            }
          }}
        />
        {streaming ? (
          <button className="chat-send" onClick={() => cancel?.()}>■</button>
        ) : (
          <button className="chat-send" onClick={send2} disabled={!input.trim()}>➤</button>
        )}
      </div>
    </div>
  )
}

function renderMd(md: string): string {
  try {
    // Sync + DOMPurify-sanitized; diagrams are inert in chat, which is fine.
    return renderToStaticHTML(md)
  } catch {
    return md.replace(/</g, '&lt;')
  }
}
