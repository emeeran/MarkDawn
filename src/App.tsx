import { listen } from '@tauri-apps/api/event'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { useEffect, useRef, useState } from 'react'
import type { ITocItem } from '@muyajs/core'
import { setSelection } from './ai/selection'
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
    void settings.load()
    void tauri.recentGet().then(setRecents).catch(() => {})
    const unlisteners = [
      listen<string>('open-path', (e) => void useTabs.getState().open(e.payload)),
      listen<string[]>('fs-changed', (e) => handleFsChanged(e.payload)),
      listen<{ action: string; extra?: string }>('notepad:transform', (e) => {
        setSelStable(false)
        setDiff({ ...e.payload, key: Date.now() })
      }),
      listen('notepad:open-settings', () => setSettingsOpen(true)),
      // Native menu (accelerators live Rust-side; no duplicate JS keybindings).
      listen<string>('menu-action', (e) => dispatchMenuAction(e.payload)),
    ]
    return () => { unlisteners.forEach((u) => void u.then((f) => f())) }
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

  return (
    <div className="app">
      <div className="main-row">
        {settings.sidebarOpen && (
          <div className="sidebar">
            <div className="sidebar-tabs">
              <button className={settings.sidebarTab === 'files' ? 'on' : ''} onClick={() => settings.set('sidebarTab', 'files')}>Files</button>
              <button className={settings.sidebarTab === 'outline' ? 'on' : ''} onClick={() => settings.set('sidebarTab', 'outline')}>Outline</button>
            </div>
            {settings.sidebarTab === 'files' ? <FileTree /> : <Outline toc={toc} />}
          </div>
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
            <Welcome recents={recents} />
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

function Welcome({ recents }: { recents: string[] }) {
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
            void openFileDialog({ directory: true }).then((d) => {
              if (typeof d === 'string') void workspace.openRoot(d)
            })
          }
        >
          Open folder…
        </button>
        <button
          onClick={() =>
            void openFileDialog({ multiple: false }).then((p) => {
              if (typeof p === 'string') void tabs.open(p)
            })
          }
        >
          Open file…
        </button>
        <button onClick={() => tabs.openUntitled()}>New file</button>
      </div>
      {recents.length > 0 && (
        <div className="welcome-recents">
          <h3>Recent</h3>
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
