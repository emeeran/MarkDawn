export const BASE_SYSTEM = `You are a writing assistant embedded in a Markdown editor. Be concise and practical. When asked to rewrite or continue text, output only the resulting Markdown — no preamble, no code fences around the whole answer, no commentary, unless the user explicitly asks for explanation.`

export const GHOST_SYSTEM = `You are an inline autocomplete engine. Continue the user's Markdown text naturally in their voice and style. Output ONLY the continuation — no preamble, no repetition of existing text, at most two sentences.`

export const TRANSFORM_PROMPTS: Record<string, (selection: string) => string> = {
  humanize: (s) => `# Humanize Selected Text

## ROLE

Act as an expert human editor and natural-language writer.

Your task is to rewrite the **selected text** so it sounds genuinely written by a thoughtful human rather than generated, templated, or mechanically polished.

## OBJECTIVES

* Preserve the **original meaning, facts, intent, and important details**.
* Make the writing sound **natural, authentic, and human**.
* Improve clarity and readability without making the text unnecessarily sophisticated.
* Remove obvious AI-writing patterns, clichés, repetition, and formulaic phrasing.
* Preserve the author's personality and approximate voice.
* Keep the original structure when it works; restructure only when necessary.
* Do not introduce new facts, opinions, examples, or claims.
* Do not change technical terminology when it is accurate and necessary.

## HUMAN WRITING STYLE

Prefer:

* Natural sentence variation.
* A mixture of short, medium, and longer sentences.
* Clear and conversational wording where appropriate.
* Specific, concrete language over generic expressions.
* Natural transitions rather than excessive linking phrases.
* Occasional contractions when appropriate to the context.
* A confident but not artificially polished tone.
* Paragraphs that feel naturally organized rather than mechanically symmetrical.

Avoid:

* Generic AI phrases such as:

  * "In today's rapidly evolving world"
  * "It is important to note that"
  * "In conclusion"
  * "Delve into"
  * "A testament to"
  * "Furthermore"
  * "Moreover"
  * "Unlock the potential"
  * "Seamless"
  * "Robust"
  * "Game-changer"
  * "Landscape"
* Excessive use of em dashes.
* Repetitive sentence structures.
* Overuse of headings and bullet points.
* Unnecessary summaries that merely repeat what was already said.
* Excessive adjectives and promotional language.
* Artificially perfect grammar that makes the writing feel unnatural.
* Corporate jargon and marketing language unless the original requires it.
* Padding or filler sentences.
* Repetitive conclusions.
* Writing that sounds like it is trying to "sound human."

## VOICE

First infer the writing style from the selected text.

Then preserve its appropriate characteristics, such as:

* Formal → remain professional but natural.
* Academic → remain precise and evidence-oriented.
* Technical → remain technically accurate and clear.
* Business → remain concise and professional.
* Personal → retain personality and warmth.
* Blog/article → make it engaging and readable.
* Social media → make it natural and direct.

Do **not** impose a conversational style on text that is supposed to be formal, academic, legal, or technical.

## EDITING PROCESS

1. Understand the original meaning and intent.
2. Identify unnatural, repetitive, generic, or overly polished passages.
3. Rewrite those passages using natural human phrasing.
4. Vary sentence rhythm and paragraph structure.
5. Remove unnecessary filler and jargon.
6. Preserve important terminology, facts, names, numbers, links, and formatting.
7. Check that the rewritten version still communicates exactly what the original intended.
8. Perform a final pass specifically for phrases or patterns that make the text sound AI-generated.

## IMPORTANT RULES

**Do not over-humanize.**

The goal is not to make the writing casual, imperfect, or deliberately "undetectable." The goal is to make it **natural, credible, and appropriate for a real human writer**.

Do not:

* Add intentional grammatical mistakes.
* Insert fake personal experiences.
* Invent emotions or opinions.
* Add slang unless the original voice uses it.
* Change the author's position.
* Alter factual claims.
* Add citations or sources that were not present.
* Remove useful technical information simply to make the text simpler.

## OUTPUT

Return **only the rewritten text**.

Do not explain what you changed.

Do not provide a before/after comparison.

Do not add an introduction such as "Here is the humanized version."

### SELECTED TEXT

${s}`,
  improve: (s) => `Improve the writing quality of this text. Keep its meaning, voice, and language:\n\n${s}`,
  grammar: (s) => `Fix grammar, spelling, and punctuation errors in this text. Change nothing else:\n\n${s}`,
  shorter: (s) => `Make this text meaningfully shorter while keeping all key information:\n\n${s}`,
  longer: (s) => `Expand this text with useful detail, keeping its structure and voice:\n\n${s}`,
  bullets: (s) => `Rewrite this text as a Markdown bullet list:\n\n${s}`,
  summarize: (s) => `Summarize this text:\n\n${s}`,
}

/** Report-style actions: output streams into the AI panel instead of the diff card. */
export const REPORT_PROMPTS: Record<string, (text: string) => string> = {
  tone: (s) => `Analyze the tone of this text. Describe the overall tone in a sentence or two, point out passages where the tone shifts or feels inconsistent (quote them briefly), and close with concrete suggestions. Use Markdown.\n\n<text>\n${s}\n</text>`,
  docSummary: (s) => `Summarize this document as a concise Markdown outline.\n\n<document>\n${s}\n</document>`,
  actionItems: (s) => `Extract a Markdown checklist of action items from this document.\n\n<document>\n${s}\n</document>`,
}

/**
 * Single source of truth for every AI feature: the selection action bar,
 * palette/menu commands, the native AI menu and the Settings toggles all
 * derive from this list. `def` is the enabled-by-default flag; settings may
 * override per feature (`aiFeatures[id] === false` disables).
 */
export interface AiFeature {
  id: string
  /** Selection action bar label. */
  label: string
  /** Native menu / palette label (without the "AI → " prefix). */
  menu: string
  /** Show in the selection action bar (selection transforms only). */
  bar?: boolean
  /** Needs a text input before running (translate / custom / draft). */
  input?: boolean
  keywords?: string
  def: boolean
}

export const AI_FEATURES: AiFeature[] = [
  { id: 'humanize', label: 'Humanize', menu: 'Humanize Selection', bar: true, def: true, keywords: 'natural human rewrite' },
  { id: 'improve', label: 'Improve writing', menu: 'Improve Writing', bar: true, def: true, keywords: 'transform rewrite' },
  { id: 'grammar', label: 'Fix grammar', menu: 'Fix Grammar', bar: true, def: true, keywords: 'spelling punctuation' },
  { id: 'shorter', label: 'Make shorter', menu: 'Shorten Selection', bar: true, def: true },
  { id: 'longer', label: 'Make longer', menu: 'Expand Selection', bar: true, def: true },
  { id: 'bullets', label: 'Bullet list', menu: 'Selection as Bullet List', bar: true, def: true },
  { id: 'summarize', label: 'Summarize', menu: 'Summarize Selection', bar: true, def: true },
  { id: 'translate', label: 'Translate…', menu: 'Translate Selection…', bar: true, input: true, def: true },
  { id: 'custom', label: 'Custom prompt…', menu: 'Custom Prompt…', bar: true, input: true, def: true },
  { id: 'tone', label: 'Check tone', menu: 'Tone Report', def: true, keywords: 'review style' },
  { id: 'docSummary', label: 'Summarize document', menu: 'Summarize Document', def: true, keywords: 'outline tldr' },
  { id: 'actionItems', label: 'Extract action items', menu: 'Extract Action Items', def: true, keywords: 'tasks todo checklist' },
  { id: 'continue', label: 'Continue writing', menu: 'Continue Writing', def: true, keywords: 'write more' },
  { id: 'draft', label: 'Draft from prompt…', menu: 'Draft from Prompt…', input: true, def: true, keywords: 'generate write new' },
]

/** Selection action bar entries (order = AI_FEATURES order). */
export const QUICK_ACTIONS: { id: string; label: string }[] = AI_FEATURES.filter((f) => f.bar).map(
  ({ id, label }) => ({ id, label }),
)

/** Absent key = enabled; an explicit `false` disables. */
export function featureEnabled(enabled: Record<string, boolean>, id: string): boolean {
  return enabled[id] !== false
}

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
