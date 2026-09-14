export const BASE_SYSTEM = `You are a writing assistant embedded in a Markdown editor. Be concise and practical. When asked to rewrite or continue text, output only the resulting Markdown — no preamble, no code fences around the whole answer, no commentary, unless the user explicitly asks for explanation.`

export const GHOST_SYSTEM = `You are an inline autocomplete engine. Continue the user's Markdown text naturally in their voice and style. Output ONLY the continuation — no preamble, no repetition of existing text, at most two sentences.`

export const TRANSFORM_PROMPTS: Record<string, (selection: string) => string> = {
  improve: (s) => `Improve the writing quality of this text. Keep its meaning, voice, and language:\n\n${s}`,
  grammar: (s) => `Fix grammar, spelling, and punctuation errors in this text. Change nothing else:\n\n${s}`,
  shorter: (s) => `Make this text meaningfully shorter while keeping all key information:\n\n${s}`,
  longer: (s) => `Expand this text with useful detail, keeping its structure and voice:\n\n${s}`,
  bullets: (s) => `Rewrite this text as a Markdown bullet list:\n\n${s}`,
  summarize: (s) => `Summarize this text:\n\n${s}`,
}

export const QUICK_ACTIONS: { id: keyof typeof TRANSFORM_PROMPTS | 'translate' | 'custom'; label: string }[] = [
  { id: 'improve', label: 'Improve writing' },
  { id: 'grammar', label: 'Fix grammar' },
  { id: 'shorter', label: 'Make shorter' },
  { id: 'longer', label: 'Make longer' },
  { id: 'bullets', label: 'Bullet list' },
  { id: 'summarize', label: 'Summarize' },
  { id: 'translate', label: 'Translate…' },
  { id: 'custom', label: 'Custom prompt…' },
]

export function buildTransformPrompt(action: string, selection: string, extra?: string): string {
  if (action === 'translate') {
    return `Translate this text to ${extra || 'English'}, preserving Markdown formatting:\n\n${selection}`
  }
  if (action === 'custom') {
    return `${extra}\n\nText:\n${selection}`
  }
  const fn = TRANSFORM_PROMPTS[action]
  return fn ? fn(selection) : `${action}\n\n${selection}`
}

export const DOC_CHAT_TEMPLATE = (ctx: string) =>
  `Here is my current document for context:\n\n<document>\n${ctx}\n</document>`
