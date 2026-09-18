import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import type { ITocItem } from '@muyajs/core'
import markDawnLogo from './assets/markdawn-logo.png'
import { captureRange, readDomSelection, setSelection } from './ai/selection'
import { runSelectionTransform } from './ai/transform'
import { isReading } from './ai/tts'
import { FORMAT_ACTIONS, PARAGRAPH_ACTIONS } from './editor/inserts'
import { MuyaEditor } from './editor/MuyaEditor'
import { editOp, getCommands } from './commands/registry'
import { pickFolder, pickFile, tauri } from './lib/tauri'
import { ChatPanel } from './panels/ChatPanel'
import { CommandPalette } from './panels/CommandPalette'
import { FileTree } from './panels/FileTree'
import { FindBar } from './panels/FindBar'
import { Outline } from './panels/Outline'
import { SettingsDialog } from './panels/SettingsDialog'
import { WorkspaceSearch } from './panels/WorkspaceSearch'
import { WordCount } from './panels/WordCount'
import { TabsBar } from './panels/TabsBar'
import { DiffPopover, SelectionActionBar } from './panels/TransformPopover'
import { useChat } from './stores/chat'
import { useSettings } from './stores/settings'
import { useTabs } from './stores/tabs'
import { useToast } from './stores/toast'
import { useWorkspace } from './stores/workspace'
import type { SelectionInfo, ThemeId } from './types'

interface DiffRequest {
  action: string
  extra?: string
  range: Range | null
  key: number
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

function resolvedTheme(theme: ThemeId): string {
  return theme === 'auto' ? (darkQuery.matches ? 'night' : 'github') : theme
}

/** Guard across re-renders: the flush must happen exactly once per quit. */
let quitting = false

async function quitFlow() {
  if (quitting) return
  quitting = true
  try {
    await useTabs.getState().flushAll()
  } finally {
    await invoke('quit_now').catch(() => {})
  }
}

export function App() {
  const settings = useSettings()
  const { tabs, activeId, banner, setBanner, setContent } = useTabs()
  const toast = useToast((s) => s.message)

  const [toc, setToc] = useState<ITocItem[]>([])
  const [recents, setRecents] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [selUi, setSelUi] = useState<{ text: string; rect: SelectionInfo['rect'] }>({ text: '', rect: null })
  const [diff, setDiff] = useState<DiffRequest | null>(null)
  const selStableTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [selStable, setSelStable] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  const activeTab = tabs.find((t) => t.id === activeId) ?? null

  // --- boot: settings, recents, native menu + backend events ---
  useEffect(() => {
    void settings.load()
    void useChat.getState().load()
    void tauri.recentGet().then(setRecents).catch(() => {})
    const unlisteners = [
      listen<string>('open-path', (e) => void useTabs.getState().open(e.payload)),
      listen<string[]>('fs-changed', (e) => handleFsChanged(e.payload)),
      // Native menu (accelerators live Rust-side; no duplicate JS keybindings).
      listen<string>('menu-action', (e) => dispatchMenuAction(e.payload)),
      // Rust intercepted the quit; flush saves, then really exit.
      listen('quit-requested', () => void quitFlow()),
    ]
    // Files from the very first launch (`notepad foo.md`).
    void tauri
      .startupFiles()
      .then((files) => files.forEach((f) => void useTabs.getState().open(f)))
      .catch(() => {})

    // Window close (X button): same flush-then-exit contract as app quit.
    let unClose: (() => void) | undefined
    void getCurrentWindow()
      .onCloseRequested(async (e) => {
        e.preventDefault()
        await quitFlow()
      })
      .then((fn) => { unClose = fn })

    // Drag-and-drop: open markdown files, import images into the active doc.
    let unDrop: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return
        for (const path of event.payload.paths) {
          if (/\.(md|markdown|txt)$/i.test(path)) {
            void useTabs.getState().open(path)
          } else {
            window.dispatchEvent(new CustomEvent('notepad:drop-image', { detail: path }))
          }
        }
      })
      .then((fn) => { unDrop = fn })

    // DOM CustomEvents from feature modules (NOT tauri IPC events — these must
    // use window listeners; tauri listen() never sees them).
    const onTransform = (e: Event) => {
      const { action, extra, range } = (e as CustomEvent<{ action: string; extra?: string; range: Range | null }>).detail
      setSelStable(false)
      setDiff({ action, extra, range, key: Date.now() })
    }
    const onOpenSettings = () => setSettingsOpen(true)
    const onClearRecents = () => clearRecents()
    window.addEventListener('notepad:transform', onTransform)
    window.addEventListener('notepad:open-settings', onOpenSettings)
    window.addEventListener('notepad:clear-recents', onClearRecents)
    return () => {
      unlisteners.forEach((u) => void u.then((f) => f()))
      unClose?.()
      unDrop?.()
      window.removeEventListener('notepad:transform', onTransform)
      window.removeEventListener('notepad:open-settings', onOpenSettings)
      window.removeEventListener('notepad:clear-recents', onClearRecents)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- editor right-click menu (selection actions; plain right-click is untouched) ---
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      if (useSettings.getState().sourceMode || !readDomSelection().text.trim()) {
        setCtxMenu(null)
        return
      }
      e.preventDefault()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.transform-popover')) setCtxMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    window.addEventListener('contextmenu', onCtx)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('contextmenu', onCtx)
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // --- theme (auto follows the OS) + typography vars ---
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolvedTheme(settings.theme)
      const style = document.documentElement.style
      style.setProperty('--editor-font-size', `${settings.fontSize}px`)
      style.setProperty('--editor-line-height', `${settings.lineHeight}`)
      style.setProperty('--editor-align', settings.textAlign)
      // Empty family = app default; an empty var would nuke font resolution.
      if (settings.editorFont) style.setProperty('--editor-font-family', settings.editorFont)
      else style.removeProperty('--editor-font-family')
    }
    apply()
    if (settings.theme !== 'auto') return
    darkQuery.addEventListener('change', apply)
    return () => darkQuery.removeEventListener('change', apply)
  }, [settings.theme, settings.fontSize, settings.editorFont, settings.lineHeight, settings.textAlign])

  /**
   * Para/format/theme are prefix-dispatched (menu-only idioms); everything
   * else resolves through the command registry — one implementation for
   * palette and menu, no duplicate switches.
   */
  function dispatchMenuAction(id: string) {
    const s = useSettings.getState()
    if (id.startsWith('para.')) return void PARAGRAPH_ACTIONS[id]?.()
    if (id.startsWith('fmt.')) return void FORMAT_ACTIONS[id]?.()
    if (id.startsWith('theme:')) return s.set('theme', id.slice(6) as ThemeId)
    getCommands().find((c) => c.id === id)?.run()
  }

  function clearRecents() {
    setRecents([])
    void tauri.recentClear().catch((e) => useToast.getState().show(`Clear recents: ${e}`))
  }

  function handleFsChanged(paths: string[]) {
    const dirs = new Set(paths.map((p) => p.split(/[\\/]/).slice(0, -1).join('/')).filter(Boolean))
    dirs.forEach((d) => void useWorkspace.getState().refresh(d))

    const t = useTabs.getState()
    for (const tab of t.tabs) {
      if (!tab.path || !paths.includes(tab.path)) continue
      // Our own autosave echoes back — not an external change.
      if (t.consumeSelfSave(tab.path)) continue
      if (!tab.dirty) {
        // Quietly adopt the newer file (any tab, not just the active one).
        void tauri.readFile(tab.path).then((md) => t.markSaved(tab.id, md)).catch(() => {})
      } else {
        t.markStale(tab.path)
        if (tab.id === t.activeId) t.setBanner('This file changed on disk.')
        // Background dirty tabs surface the banner when activated (setActive).
      }
    }
  }

  function reloadFromDisk() {
    const t = useTabs.getState()
    const active = t.tabs.find((tab) => tab.id === t.activeId)
    setBanner(null)
    if (active?.path) {
      t.clearStale(active.path)
      void tauri.readFile(active.path).then((md) => t.markSaved(active.id, md)).catch(() => {})
    }
  }

  function onInput(markdown: string, nextToc: ITocItem[]) {
    if (activeId) setContent(activeId, markdown)
    setToc(nextToc)
    setSelStable(false)
  }

  function onSelection(sel: SelectionInfo) {
    // Read-aloud highlights via the live selection; don't pop the AI bar mid-read.
    if (isReading()) {
      setSelStable(false)
      return
    }
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
          {settings.findOpen && <FindBar onClose={() => settings.set('findOpen', false)} />}
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
                setDiff({ action, extra, range: captureRange(), key: Date.now() })
              }}
            />
          )}
          {diff && !settings.sourceMode && (
            <DiffPopover
              key={diff.key}
              request={{ action: diff.action, extra: diff.extra }}
              range={diff.range}
              selRect={selUi.rect}
              onClose={() => setDiff(null)}
            />
          )}
          {ctxMenu && (
            <div className="transform-popover" style={{ top: ctxMenu.y, left: Math.min(ctxMenu.x, window.innerWidth - 130) }}>
              <button onClick={() => { setCtxMenu(null); editOp('cut') }}>Cut</button>
              <button onClick={() => { setCtxMenu(null); editOp('copy') }}>Copy</button>
              <button onClick={() => { setCtxMenu(null); editOp('paste') }}>Paste</button>
              <button onClick={() => {
                setCtxMenu(null)
                runSelectionTransform('humanize')
              }}>Humanize</button>
            </div>
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
      {settings.palette && <CommandPalette mode={settings.palette} onClose={() => settings.set('palette', null)} />}
      {settings.workspaceSearchOpen && <WorkspaceSearch onClose={() => settings.set('workspaceSearchOpen', false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function Welcome({ recents, onClearRecents }: { recents: string[]; onClearRecents: () => void }) {
  const tabs = useTabs()
  const workspace = useWorkspace()
  return (
    <div className="welcome">
      <img src={markDawnLogo} alt="MarkDawn logo" className="welcome-logo" draggable={false} />
      <h1>MarkDawn</h1>
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
