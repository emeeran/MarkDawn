import { renderToStaticHTML } from '@muyajs/core'
import { readAloud, stopReading } from '../ai/tts'
import { runSelectionTransform } from '../ai/transform'
import { getMarkdown, getMuya, getTOC } from '../editor/editBridge'
import { pickFile, pickFolder, pickSaveFile, tauri } from '../lib/tauri'
import { useChat } from '../stores/chat'
import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'
import { useToast } from '../stores/toast'
import { useWorkspace } from '../stores/workspace'
import { themeRaw } from '../themes/raw'
import type { ThemeId } from '../types'

export interface Command {
  id: string
  title: string
  section: string
  keywords?: string
  run: () => void
}

const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'auto', label: 'Auto (light/dark)' },
  { id: 'github', label: 'GitHub' },
  { id: 'night', label: 'Night' },
  { id: 'newsprint', label: 'Newsprint' },
  { id: 'pixyll', label: 'Pixyll' },
]

async function openFile() {
  try {
    const path = await pickFile([{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }])
    if (path) void useTabs.getState().open(path)
  } catch (e) {
    useToast.getState().show(`Open file: ${e}`)
  }
}

async function openFolder() {
  try {
    const dir = await pickFolder()
    if (dir) void useWorkspace.getState().openRoot(dir)
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
  const path = await pickSaveFile(`${title.replace(/\.md$/, '')}.html`, [
    { name: 'HTML', extensions: ['html'] },
  ]).catch((e) => {
    useToast.getState().show(`Export: ${e}`)
    return null
  })
  if (!path) return
  // Match pandoc's export guard: refuse to clobber an existing destination.
  if (await tauri.readFile(path).then(() => true).catch(() => false)) {
    return useToast.getState().show(`Export: ${path} already exists — remove or rename it first`)
  }
  try {
    await tauri.fsAllow(path)
    await tauri.writeFile(path, html)
    useToast.getState().show(`Exported ${path}`)
  } catch (e) {
    useToast.getState().show(`Export failed: ${e}`)
  }
}

async function exportPandoc(format: string) {
  const tab = useTabs.getState().tabs.find((t) => t.id === useTabs.getState().activeId)
  if (!tab?.path) return useToast.getState().show('Save the file first (⌘S), then export')
  if (!(await tauri.pandocAvailable())) return useToast.getState().show('pandoc is not installed — see pandoc.org')
  try {
    const dest = await tauri.exportPandoc(tab.path, format)
    useToast.getState().show(`Exported ${dest}`)
  } catch (e) {
    useToast.getState().show(`Export: ${e}`)
  }
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

/** Every non-prefix action (menus dispatch these ids; the palette lists them). */
export function getCommands(): Command[] {
  const tabs = useTabs.getState()
  const settings = useSettings.getState()
  const cmd = (id: string, title: string, section: string, run: () => void, keywords?: string): Command =>
    ({ id, title, section, run, keywords })

  return [
    cmd('file.new', 'New file', 'File', () => tabs.openUntitled()),
    cmd('file.open', 'Open file…', 'File', () => void openFile()),
    cmd('file.openFolder', 'Open folder…', 'File', () => void openFolder()),
    cmd('file.save', 'Save', 'File', () => void tabs.saveActive()),
    cmd('file.saveAs', 'Save as…', 'File', () => void tabs.saveActiveAs()),
    cmd('file.closeTab', 'Close tab', 'File', () => { if (tabs.activeId) void tabs.close(tabs.activeId) }),
    cmd('file.reopenTab', 'Reopen closed tab', 'File', () => void tabs.reopenClosed(), 'undo close'),

    cmd('edit.undo', 'Undo', 'Edit', () => getMuya()?.undo(), 'revert last action'),
    cmd('edit.redo', 'Redo', 'Edit', () => getMuya()?.redo(), 're-apply undone'),
    cmd('edit.find', `${settings.findOpen ? '✓ ' : ''}Find / Replace`, 'Edit', () => settings.set('findOpen', !settings.findOpen)),
    cmd('edit.searchWorkspace', 'Search in workspace…', 'Edit', () => settings.set('workspaceSearchOpen', true), 'grep find across files'),

    cmd('view.sidebar', `${settings.sidebarOpen ? '✓ ' : ''}File tree`, 'View', () => settings.set('sidebarOpen', !settings.sidebarOpen), 'panel sidebar'),
    cmd('view.outline', 'Outline', 'View', () => { settings.set('sidebarOpen', true); settings.set('sidebarTab', 'outline') }, 'toc headings'),
    cmd('view.ai', `${settings.aiPanelOpen ? '✓ ' : ''}AI panel`, 'View', () => settings.set('aiPanelOpen', !settings.aiPanelOpen), 'chat'),
    cmd('view.focus', `${settings.focusMode ? '✓ ' : ''}Focus mode`, 'View', () => settings.set('focusMode', !settings.focusMode)),
    cmd('view.typewriter', `${settings.typewriterMode ? '✓ ' : ''}Typewriter mode`, 'View', () => settings.set('typewriterMode', !settings.typewriterMode)),
    cmd('view.ghost', `${settings.ghostText ? '✓ ' : ''}Ghost text autocomplete`, 'View', () => settings.set('ghostText', !settings.ghostText), 'autocomplete ai inline'),
    cmd('view.wordCount', `${settings.showWordCount ? '✓ ' : ''}Word count`, 'View', () => settings.set('showWordCount', !settings.showWordCount), 'statistics status'),
    cmd('view.fontBigger', 'Bigger text', 'View', () => settings.set('fontSize', Math.min(32, settings.fontSize + 1)), 'zoom in size'),
    cmd('view.fontSmaller', 'Smaller text', 'View', () => settings.set('fontSize', Math.max(12, settings.fontSize - 1)), 'zoom out size'),
    cmd('view.fontReset', 'Reset text size', 'View', () => settings.set('fontSize', 16), 'zoom default'),
    cmd('view.source', `${settings.sourceMode ? '✓ ' : ''}Source mode`, 'View', () => settings.set('sourceMode', !settings.sourceMode), 'raw markdown'),
    cmd('view.palette', 'Command palette…', 'View', () => settings.set('palette', 'actions')),
    cmd('view.quickopen', 'Quick open…', 'View', () => settings.set('palette', 'files')),
    ...THEMES.map((t) =>
      cmd(`theme.${t.id}`, `Theme: ${t.label}`, 'View', () => settings.set('theme', t.id), 'appearance'),
    ),

    cmd('export.html', 'Export → HTML', 'Export', () => void exportHtml()),
    cmd('export.pdf', 'Export → PDF (print dialog)', 'Export', () => window.print(), 'print'),
    cmd('export.docx', 'Export → Word (docx, pandoc)', 'Export', () => void exportPandoc('docx')),
    cmd('export.odt', 'Export → OpenDocument (odt, pandoc)', 'Export', () => void exportPandoc('odt')),
    cmd('export.latex', 'Export → LaTeX (pandoc)', 'Export', () => void exportPandoc('latex')),
    cmd('export.rtf', 'Export → RTF (pandoc)', 'Export', () => void exportPandoc('rtf')),
    cmd('export.epub', 'Export → EPUB (pandoc)', 'Export', () => void exportPandoc('epub')),

    cmd('ai.humanize', 'AI → Humanize selection', 'AI', () => void runSelectionTransform('humanize'), 'natural human rewrite'),
    cmd('ai.improve', 'AI → Improve selection', 'AI', () => void runSelectionTransform('improve'), 'transform rewrite'),
    cmd('ai.grammar', 'AI → Fix grammar in selection', 'AI', () => void runSelectionTransform('grammar')),
    cmd('ai.continue', 'AI → Continue writing', 'AI', continueWriting),
    cmd('ai.summarize', 'AI → Summarize document', 'AI', () => aiDocAction('Summarize this document as a concise Markdown outline.')),
    cmd('ai.actions', 'AI → Extract action items', 'AI', () => aiDocAction('Extract a Markdown checklist of action items from this document.')),
    cmd('ai.chatClear', 'AI → Clear conversation', 'AI', () => {
      useChat.getState().clear()
      useToast.getState().show('AI conversation cleared')
    }, 'clear history'),

    cmd('tts.doc', 'Read aloud → Document', 'Read Aloud', () => void readAloud('doc'), 'speak tts'),
    cmd('tts.sel', 'Read aloud → Selection', 'Read Aloud', () => void readAloud('sel')),
    cmd('tts.cursor', 'Read aloud → From cursor', 'Read Aloud', () => void readAloud('cursor')),
    cmd('tts.stop', 'Read aloud → Stop', 'Read Aloud', () => stopReading()),

    cmd('app.settings', 'Open settings…', 'App', () => window.dispatchEvent(new CustomEvent('notepad:open-settings')), 'preferences keys api'),
    cmd('app.clearRecents', 'Clear recent history', 'App', () => window.dispatchEvent(new CustomEvent('notepad:clear-recents')), 'recents recent files clear'),
    cmd('app.about', 'About MarkDawn', 'App', () => useToast.getState().show('MarkDawn — seamless Markdown with AI')),
  ]
}
