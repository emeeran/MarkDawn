import { listen } from '@tauri-apps/api/event'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import { setSelection } from './ai/selection'
import { MuyaEditor } from './editor/MuyaEditor'
import { tauri } from './lib/tauri'
import { ChatPanel } from './panels/ChatPanel'
import { CommandPalette } from './panels/CommandPalette'
import { FileTree } from './panels/FileTree'
import { FindBar } from './panels/FindBar'
import { Outline } from './panels/Outline'
import { SettingsDialog } from './panels/SettingsDialog'
import { StatusBar } from './panels/StatusBar'
import { TabsBar } from './panels/TabsBar'
import { DiffPopover, SelectionActionBar } from './panels/TransformPopover'
import { useSettings } from './stores/settings'
import { useTabs } from './stores/tabs'
import { useToast } from './stores/toast'
import { useWorkspace } from './stores/workspace'
import type { ITocItem } from '@muyajs/core'

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
  const [selUi, setSelUi] = useState<{ text: string; rect: import('./types').SelectionInfo['rect'] }>({ text: '', rect: null })
  const [diff, setDiff] = useState<DiffRequest | null>(null)
  const selStableTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [selStable, setSelStable] = useState(false)

  const activeTab = tabs.find((t) => t.id === activeId) ?? null

  // --- boot ---
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
    ]
    return () => { unlisteners.forEach((u) => void u.then((f) => f())) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- theme + font size ---
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--editor-font-size', `${settings.fontSize}px`)
  }, [settings.theme, settings.fontSize])

  // --- keyboard ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      const t = useTabs.getState()
      const s = useSettings.getState()
      if (key === 'k') { e.preventDefault(); setPalette('actions') }
      else if (key === 'p') { e.preventDefault(); setPalette('files') }
      else if (key === 'f' && e.shiftKey) { e.preventDefault(); s.set('focusMode', !s.focusMode) }
      else if (key === 'f') { e.preventDefault(); setFindOpen(true) }
      else if (key === 's') { e.preventDefault(); void t.saveActive() }
      else if (key === 'n' && !e.shiftKey) { e.preventDefault(); t.openUntitled() }
      else if (key === 'w') { e.preventDefault(); if (t.activeId) void t.close(t.activeId) }
      else if (key === ',') { e.preventDefault(); setSettingsOpen(true) }
      else if (key === 'b') { e.preventDefault(); s.set('sidebarOpen', !s.sidebarOpen) }
      else if (key === 't' && e.altKey) { e.preventDefault(); s.set('typewriterMode', !s.typewriterMode) }
      else if (key === '/') { e.preventDefault(); s.set('aiPanelOpen', !s.aiPanelOpen) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  function handleFsChanged(paths: string[]) {
    // refresh tree dirs
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

  // --- editor callbacks ---
  function onInput(markdown: string, nextToc: ITocItem[]) {
    if (activeId) setContent(activeId, markdown)
    setToc(nextToc)
    setSelStable(false)
  }

  function onSelection(sel: import('./types').SelectionInfo) {
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

  const wordCount = useMemo(
    () => (activeTab?.markdown ?? '').split(/\s+/).filter(Boolean).length,
    [activeTab?.markdown],
  )

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
            <MuyaEditor key={activeTab.id} tab={activeTab} onInput={onInput} onSelection={onSelection} />
          ) : (
            <Welcome recents={recents} />
          )}
          {selStable && selUi.text && !diff && (
            <SelectionActionBar
              rect={selUi.rect}
              onAction={(action, extra) => {
                setSelStable(false)
                setDiff({ action, extra, key: Date.now() })
              }}
            />
          )}
          {diff && (
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

      <StatusBar wordCount={wordCount} />
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
