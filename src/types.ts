export interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

export interface Tab {
  id: string
  path: string | null
  title: string
  dirty: boolean
  markdown: string
}

export type ProviderId = 'anthropic' | 'openai' | 'ollama'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export type AiEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface AiStreamRequest {
  provider: ProviderId
  model: string
  system: string
  messages: ChatMessage[]
  maxChars?: number
  ollamaUrl?: string
}

export interface SelectionInfo {
  text: string
  rect: { top: number; left: number; bottom: number; right: number } | null
}

export interface Settings {
  theme: 'github' | 'night' | 'newsprint' | 'pixyll'
  fontSize: number
  focusMode: boolean
  typewriterMode: boolean
  ghostText: boolean
  aiPanelOpen: boolean
  sidebarOpen: boolean
  sidebarTab: 'files' | 'outline'
  provider: ProviderId
  models: Record<ProviderId, string>
  ollamaUrl: string
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'github',
  fontSize: 16,
  focusMode: false,
  typewriterMode: false,
  ghostText: false,
  aiPanelOpen: true,
  sidebarOpen: true,
  sidebarTab: 'files',
  provider: 'anthropic',
  models: {
    anthropic: 'claude-sonnet-5',
    openai: 'gpt-5.2',
    ollama: 'llama3.2',
  },
  ollamaUrl: 'http://localhost:11434',
}
