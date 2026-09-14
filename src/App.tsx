import { listen } from '@tauri-apps/api/event'
import { pickFile, pickFolder } from './lib/tauri'
import { useEffect, useRef, useState } from 'react'
import type { ITocItem } from '@muyajs/core'
import { setSelection } from './ai/selection'
import { readAloud, stopReading } from './ai/tts'
import { FORMAT_ACTIONS, PARAGRAAPH_ACTIONS } from './editor/inserts'
import { MuyaEditor } from './editor/MuyaEditor'
import { getCommands } from './commands/registry'
import { tauri } from './lib/tauri'
import { ChatPanel } from './panels/ChatPanel'
import { CommandPalette } from './panels/CommandPalette'
import { FileTree } from './panels/FileTree'
import { FindBar } from './panels/FindBar'
import { Outline } from './panels/Outline'
import { SettingsDialog } from './panels/SettingsDialog'
import { WordCount } from './panels/WordCount'
import { TabsBar } from './panels/TabsBar'
import { DiffPopover, SelectionActionBar } from './panels/TransformPopover'
import { useChat } from './stores/chat'
import { useSettings } from './stores/settings'
import { useTabs } from './stores/tabs'
import { useToast } from './stores/toast'
import { useWorkspace } from './stores/workspace'
import type { SelectionInfo, Settings as SettingsType } from './types'

interface DiffRequest {
  action: string
  extra?: string
  key: number
}

export function App() {
  const settings = useSettings()
  const { tabs, activeId, banner, setBanner, setContent } = useTabs()
  const toast = useToast((s) => s.message)

  const [toc, setToc] = useState<ITocItem[]>([])
  const [findOpen, setFindOpen] = useState(false)
  const [palette, setPalette] = useState<null | 'actions' | 'files'>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const [selUi, setSelUi] = useState<{ text: string; rect: SelectionInfo['rect'] }>({ text: '', rect: null })
  const [diff, setDiff] = useState<DiffRequest | null>(null)
  const selStableTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [selStable, setSelStable] = useState(false)

  const activeTab = tabs.find((t) => t.id === activeId) ?? null

  // --- boot: settings, recents, native menu + backend events ---
  useEffect(() => {
    void import('./lib/tauri').then(({ dbg }) => dbg('boot: app effect ran'))
    void settings.load()
    void useChat.getState().load()
    void tauri.recentGet().then(setRecents).catch(() => {})
    // DEBUG: channel delivery probe at boot
    void import('./lib/tauri').then(({ debugChannel }) =>
      debugChannel()
        .then((v) => { document.title = `NP: chan-ok ${v}` })
        .catch((e) => { document.title = `NP: chan-err ${e}` }),
    )
    const unlisteners = [
      listen<string>('open-path', (e) => void useTabs.getState().open(e.payload)),
      listen<string[]>('fs-changed', (e) => handleFsChanged(e.payload)),
      // Native menu (accelerators live Rust-side; no duplicate JS keybindings).
      listen<string>('menu-action', (e) => dispatchMenuAction(e.payload)),
    ]
    // DOM CustomEvents from feature modules (NOT tauri IPC events — these must
    // use window listeners; tauri listen() never sees them).
    const onTransform = (e: Event) => {
      const { action, extra } = (e as CustomEvent<{ action: string; extra?: string }>).detail
      setSelStable(false)
      setDiff({ action, extra, key: Date.now() })
    }
    const onOpenSettings = () => setSettingsOpen(true)
    const onClearRecents = () => clearRecents()
    window.addEventListener('notepad:transform', onTransform)
    window.addEventListener('notepad:open-settings', onOpenSettings)
    window.addEventListener('notepad:clear-recents', onClearRecents)
    return () => {
      unlisteners.forEach((u) => void u.then((f) => f()))
      window.removeEventListener('notepad:transform', onTransform)
      window.removeEventListener('notepad:open-settings', onOpenSettings)
      window.removeEventListener('notepad:clear-recents', onClearRecents)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- theme + font size ---
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--editor-font-size', `${settings.fontSize}px`)
  }, [settings.theme, settings.fontSize])

  function dispatchMenuAction(id: string) {
    const s = useSettings.getState()
    const t = useTabs.getState()
    if (id.startsWith('para.')) return void PARAGRAAPH_ACTIONS[id]?.()
    if (id.startsWith('fmt.')) return void FORMAT_ACTIONS[id]?.()
    if (id.startsWith('theme:')) return s.set('theme', id.slice(6) as SettingsType['theme'])
    switch (id) {
      case 'file.new': return t.openUntitled()
      case 'file.save': return void t.saveActive()
      case 'file.saveAs': return void t.saveActiveAs()
      case 'file.closeTab': return t.activeId ? void t.close(t.activeId) : undefined
      case 'edit.find': return setFindOpen((v) => !v)
      case 'view.source': {
        if (s.sourceMode) setSelection({ text: '', rect: null })
        return s.set('sourceMode', !s.sourceMode)
      }
      case 'view.focus': return s.set('focusMode', !s.focusMode)
      case 'view.typewriter': return s.set('typewriterMode', !s.typewriterMode)
      case 'view.sidebar': return s.set('sidebarOpen', !s.sidebarOpen)
      case 'view.outline': {
        s.set('sidebarOpen', true)
        return s.set('sidebarTab', 'outline')
      }
      case 'view.ai': return s.set('aiPanelOpen', !s.aiPanelOpen)
      case 'view.chatClear':
        useChat.getState().clear()
        return useToast.getState().show('AI conversation cleared')
      case 'tts.doc': return void readAloud('doc')
      case 'tts.sel': return void readAloud('sel')
      case 'tts.cursor': return void readAloud('cursor')
      case 'tts.stop': return stopReading()
      case 'app.settings': return setSettingsOpen(true)
      case 'view.palette': return setPalette('actions')
      case 'view.quickopen': return setPalette('files')
      case 'help.about': return useToast.getState().show('Notepad v0.1.0 — seamless Markdown with AI')
      default: {
        // file.open / file.openFolder / app.settings / export.* live in the registry
        const cmd = getCommands().find((c) => c.id === id)
        if (cmd) cmd.run()
      }
    }
  }

  function clearRecents() {
    setRecents([])
    void tauri.recentClear().catch((e) => useToast.getState().show(`Clear recents: ${e}`))
  }

  function handleFsChanged(paths: string[]) {
    const dirs = new Set(paths.map((p) => p.split(/[\\/]/).slice(0, -1).join('/')).filter(Boolean))
    dirs.forEach((d) => void useWorkspace.getState().refresh(d))

    const t = useTabs.getState()
    const active = t.tabs.find((tab) => tab.id === t.activeId)
    if (active?.path && paths.includes(active.path)) {
      if (!active.dirty) {
        void tauri.readFile(active.path).then((md) => t.markSaved(active.id, md)).catch(() => {})
      } else {
        t.setBanner('This file changed on disk.')
      }
    }
  }

  function reloadFromDisk() {
    const t = useTabs.getState()
    const active = t.tabs.find((tab) => tab.id === t.activeId)
    setBanner(null)
    if (active?.path) void tauri.readFile(active.path).then((md) => t.markSaved(active.id, md)).catch(() => {})
  }

  function onInput(markdown: string, nextToc: ITocItem[]) {
    if (activeId) setContent(activeId, markdown)
    setToc(nextToc)
    setSelStable(false)
  }

  function onSelection(sel: SelectionInfo) {
    setSelUi({ text: sel.text, rect: sel.rect })
    clearTimeout(selStableTimer.current)
    if (sel.text) {
      selStableTimer.current = setTimeout(() => setSelStable(true), 350)
    } else {
      setSelStable(false)
      // Don't clobber an open diff popover when the selection collapses on Apply.
      if (!diff) setSelection(sel)
    }
  }

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = useSettings.getState().sidebarWidth
    const move = (ev: MouseEvent) => {
      const w = Math.min(480, Math.max(160, startW + ev.clientX - startX))
      useSettings.getState().set('sidebarWidth', w)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="app">
      <div className="main-row">
        {settings.sidebarOpen && (
          <>
            <div className="sidebar" style={{ width: settings.sidebarWidth, minWidth: settings.sidebarWidth }}>
              <div className="sidebar-tabs">
                <button className={settings.sidebarTab === 'files' ? 'on' : ''} onClick={() => settings.set('sidebarTab', 'files')}>Files</button>
                <button className={settings.sidebarTab === 'outline' ? 'on' : ''} onClick={() => settings.set('sidebarTab', 'outline')}>Outline</button>
                <button className="sidebar-fold" title="Fold sidebar (⌘⇧L)" onClick={() => settings.set('sidebarOpen', false)}>«</button>
              </div>
              {settings.sidebarTab === 'files' ? <FileTree /> : <Outline toc={toc} />}
            </div>
            <div
              className="sidebar-resize"
              title="Drag to resize · double-click to fold"
              onMouseDown={startResize}
              onDoubleClick={() => settings.set('sidebarOpen', false)}
            />
          </>
        )}

        <div className="center">
          <TabsBar />
          {banner && (
            <div className="banner">
              <span>{banner}</span>
              <span className="banner-actions">
                <button onClick={reloadFromDisk}>Reload from disk</button>
                <button onClick={() => setBanner(null)}>Keep mine</button>
              </span>
            </div>
          )}
          {findOpen && <FindBar onClose={() => setFindOpen(false)} />}
          {activeTab ? (
            settings.sourceMode ? (
              <textarea
                className="source-editor"
                autoFocus
                spellCheck={false}
                value={activeTab.markdown}
                onChange={(e) => { if (activeId) setContent(activeId, e.target.value) }}
                onKeyDown={(e) => { if (e.key === 'Escape') settings.set('sourceMode', false) }}
              />
            ) : (
              <MuyaEditor key={activeTab.id} tab={activeTab} onInput={onInput} onSelection={onSelection} />
            )
          ) : (
            <Welcome recents={recents} onClearRecents={clearRecents} />
          )}
          {selStable && selUi.text && !diff && !settings.sourceMode && (
            <SelectionActionBar
              rect={selUi.rect}
              onAction={(action, extra) => {
                setSelStable(false)
                setDiff({ action, extra, key: Date.now() })
              }}
            />
          )}
          {diff && !settings.sourceMode && (
            <DiffPopover
              key={diff.key}
              request={{ action: diff.action, extra: diff.extra }}
              selRect={selUi.rect}
              onClose={() => setDiff(null)}
            />
          )}
        </div>

        {settings.aiPanelOpen && (
          <div className="ai-panel">
            <ChatPanel />
          </div>
        )}
      </div>

      <WordCount />
      {toast && <div className="toast">{toast}</div>}
      {palette && <CommandPalette mode={palette} onClose={() => setPalette(null)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function Welcome({ recents, onClearRecents }: { recents: string[]; onClearRecents: () => void }) {
  const tabs = useTabs()
  const workspace = useWorkspace()
  return (
    <div className="welcome">
      <h1>Notepad</h1>
      <p>Seamless Markdown, with AI inside.</p>
      <div className="welcome-actions">
        <button
          className="primary"
          onClick={() =>
            pickFolder()
              .then((d) => {
                if (d) void workspace.openRoot(d)
              })
              .catch((e) => useToast.getState().show(`Open folder: ${e}`))
          }
        >
          Open folder…
        </button>
        <button
          onClick={() =>
            pickFile()
              .then((p) => {
                if (p) void tabs.open(p)
              })
              .catch((e) => useToast.getState().show(`Open file: ${e}`))
          }
        >
          Open file…
        </button>
        <button onClick={() => tabs.openUntitled()}>New file</button>
      </div>
      {recents.length > 0 && (
        <div className="welcome-recents">
          <div className="welcome-recents-head">
            <h3>Recent</h3>
            <button title="Clear recent history" onClick={onClearRecents}>Clear</button>
          </div>
          {recents.slice(0, 8).map((r) => (
            <div key={r} className="welcome-recent" onClick={() => void tabs.open(r)} title={r}>
              {r.split(/[\\/]/).pop()}
              <span className="recent-path">{r}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
