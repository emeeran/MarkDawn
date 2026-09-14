import { open, save } from '@tauri-apps/plugin-dialog'
import { renderToStaticHTML } from '@muyajs/core'
import { runSelectionTransform } from '../ai/transform'
import { getMarkdown, getTOC } from '../editor/editBridge'
import { tauri } from '../lib/tauri'
import { useChat } from '../stores/chat'
import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'
import { useToast } from '../stores/toast'
import { useWorkspace } from '../stores/workspace'
import { themeRaw } from '../themes/raw'

export interface Command {
  id: string
  title: string
  section: string
  keywords?: string
  run: () => void
}

async function openFile() {
  try {
    const path = await open({ multiple: false, filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }] })
    if (typeof path === 'string') void useTabs.getState().open(path)
  } catch (e) {
    useToast.getState().show(`Open file: ${e}`)
  }
}

async function openFolder() {
  try {
    const dir = await open({ directory: true })
    if (typeof dir === 'string') void useWorkspace.getState().openRoot(dir)
  } catch (e) {
    useToast.getState().show(`Open folder: ${e}`)
  }
}

async function exportHtml() {
  const { tabs, activeId } = useTabs.getState()
  const title = tabs.find((t) => t.id === activeId)?.title ?? 'document'
  const body = renderToStaticHTML(getMarkdown())
  const toc = getTOC()
  const tocHtml = toc.length
    ? `<nav class="toc">${toc.map((t) => `<div class="toc-${t.lvl}"><a href="#${t.githubSlug}">${t.content}</a></div>`).join('')}</nav>`
    : ''
  const theme = useSettings.getState().theme
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title><style>
${themeRaw[theme] ?? themeRaw.github}
body{max-width:800px;margin:0 auto;padding:48px 24px;line-height:1.6}
.toc{border:1px solid #ddd;border-radius:6px;padding:12px 16px;margin:24px 0}
.toc-3,.toc-4,.toc-5,.toc-6{padding-left:16px}
</style></head><body><article>${tocHtml}${body}</article></body></html>`
  const path = await save({
    defaultPath: `${title.replace(/\.md$/, '')}.html`,
    filters: [{ name: 'HTML', extensions: ['html'] }],
  }).catch((e) => {
    useToast.getState().show(`Export: ${e}`)
    return null
  })
  if (!path) return
  await tauri.writeFile(path, html)
  useToast.getState().show(`Exported ${path}`)
}

async function exportPandoc(format: string) {
  const tab = useTabs.getState().tabs.find((t) => t.id === useTabs.getState().activeId)
  if (!tab?.path) return useToast.getState().show('Save the file first (⌘S), then export')
  if (!(await tauri.pandocAvailable())) return useToast.getState().show('pandoc is not installed — see pandoc.org')
  const dest = await tauri.exportPandoc(tab.path, format)
  useToast.getState().show(`Exported ${dest}`)
}

function aiDocAction(prompt: string) {
  const md = getMarkdown()
  if (!md.trim()) return useToast.getState().show('Document is empty')
  useSettings.getState().set('aiPanelOpen', true)
  useChat.getState().send('', [
    { role: 'user', content: `${prompt}\n\n<document>\n${md}\n</document>` },
  ])
}

function continueWriting() {
  const md = getMarkdown()
  if (!md.trim()) return useToast.getState().show('Document is empty')
  useSettings.getState().set('aiPanelOpen', true)
  useChat.getState().send('', [
    { role: 'user', content: `Continue this document naturally from where it ends. Output only the continuation.\n\n<document>\n…${md.slice(-4000)}\n</document>` },
  ])
}

export function getCommands(): Command[] {
  const tabs = useTabs.getState()
  const settings = useSettings.getState()
  const cmd = (id: string, title: string, section: string, run: () => void, keywords?: string): Command =>
    ({ id, title, section, run, keywords })

  return [
    cmd('file.open', 'Open file…', 'File', () => void openFile()),
    cmd('file.openFolder', 'Open folder…', 'File', () => void openFolder()),
    cmd('file.new', 'New file', 'File', () => tabs.openUntitled()),
    cmd('file.save', 'Save', 'File', () => void tabs.saveActive()),
    cmd('file.saveAs', 'Save as…', 'File', () => void tabs.saveActiveAs()),
    cmd('file.closeTab', 'Close tab', 'File', () => { if (tabs.activeId) void tabs.close(tabs.activeId) }),

    cmd('view.toggleSidebar', 'Toggle sidebar', 'View', () => settings.set('sidebarOpen', !settings.sidebarOpen), 'panel'),
    cmd('view.toggleAI', 'Toggle AI panel', 'View', () => settings.set('aiPanelOpen', !settings.aiPanelOpen), 'chat'),
    cmd('view.focus', `${settings.focusMode ? '✓ ' : ''}Focus mode`, 'View', () => settings.set('focusMode', !settings.focusMode)),
    cmd('view.typewriter', `${settings.typewriterMode ? '✓ ' : ''}Typewriter mode`, 'View', () => settings.set('typewriterMode', !settings.typewriterMode)),
    cmd('view.ghost', `${settings.ghostText ? '✓ ' : ''}Ghost text autocomplete`, 'View', () => settings.set('ghostText', !settings.ghostText), 'autocomplete ai inline'),
    cmd('view.source', `${settings.sourceMode ? '✓ ' : ''}Source mode`, 'View', () => settings.set('sourceMode', !settings.sourceMode), 'raw markdown'),
    ...(['github', 'night', 'newsprint', 'pixyll'] as const).map((t) =>
      cmd(`theme.${t}`, `Theme: ${t}`, 'View', () => settings.set('theme', t), 'appearance'),
    ),

    cmd('export.html', 'Export → HTML', 'Export', () => void exportHtml()),
    cmd('export.pdf', 'Export → PDF (print dialog)', 'Export', () => window.print(), 'print'),
    cmd('export.docx', 'Export → Word (docx, pandoc)', 'Export', () => void exportPandoc('docx')),
    cmd('export.latex', 'Export → LaTeX (pandoc)', 'Export', () => void exportPandoc('latex')),
    cmd('export.rtf', 'Export → RTF (pandoc)', 'Export', () => void exportPandoc('rtf')),
    cmd('export.epub', 'Export → EPUB (pandoc)', 'Export', () => void exportPandoc('epub')),

    cmd('ai.improve', 'AI → Improve selection', 'AI', () => void runSelectionTransform('improve'), 'transform rewrite'),
    cmd('ai.grammar', 'AI → Fix grammar in selection', 'AI', () => void runSelectionTransform('grammar')),
    cmd('ai.continue', 'AI → Continue writing', 'AI', continueWriting),
    cmd('ai.summarize', 'AI → Summarize document', 'AI', () => aiDocAction('Summarize this document as a concise Markdown outline.')),
    cmd('ai.actions', 'AI → Extract action items', 'AI', () => aiDocAction('Extract a Markdown checklist of action items from this document.')),
    cmd('ai.chatClear', 'AI → Clear conversation', 'AI', () => {
      void import('../stores/chat').then(({ useChat }) => useChat.getState().clear())
    }, 'clear history'),

    cmd('tts.doc', 'Read aloud → Document', 'Read Aloud', () => void import('../ai/tts').then(({ readAloud }) => readAloud('doc')), 'speak tts'),
    cmd('tts.sel', 'Read aloud → Selection', 'Read Aloud', () => void import('../ai/tts').then(({ readAloud }) => readAloud('sel'))),
    cmd('tts.cursor', 'Read aloud → From cursor', 'Read Aloud', () => void import('../ai/tts').then(({ readAloud }) => readAloud('cursor'))),
    cmd('tts.stop', 'Read aloud → Stop', 'Read Aloud', () => void import('../ai/tts').then(({ stopReading }) => stopReading())),

    cmd('app.settings', 'Open settings…', 'App', () => window.dispatchEvent(new CustomEvent('notepad:open-settings')), 'preferences keys api'),
  ]
}
