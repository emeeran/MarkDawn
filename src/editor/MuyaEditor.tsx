import { Muya } from '@muyajs/core'
import { useEffect, useRef } from 'react'
import { tauri } from '../lib/tauri'
import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'
import { useToast } from '../stores/toast'
import type { ITocItem } from '@muyajs/core'
import type { SelectionInfo, Tab } from '../types'
import { readDomSelection, setSelection } from '../ai/selection'
import { insertText, registerMuya } from './editBridge'
import { editOp } from '../commands/registry'
import { addImageDataUrls, stripImageDataUrls } from './imageMap'
import { registerMuyaPlugins, setActiveDocPath } from './muyaSetup'
import { attachGhostText, detachGhostText, requestGhost, scheduleGhost } from './ghostText'

interface Props {
  tab: Tab
  onInput: (markdown: string, toc: ITocItem[]) => void
  onSelection: (sel: SelectionInfo) => void
}

let emitTimer: ReturnType<typeof setTimeout> | undefined
let typeTimer: ReturnType<typeof setTimeout> | undefined

export function MuyaEditor({ tab, onInput, onSelection }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const muyaRef = useRef<Muya | null>(null)
  const lastEmitted = useRef<string>('')
  const focusMode = useSettings((s) => s.focusMode)
  const ghostText = useSettings((s) => s.ghostText)
  const fontSize = useSettings((s) => s.fontSize)

  // --- lifecycle: one Muya instance per mounted editor host ---
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    registerMuyaPlugins()
    // Muya REPLACES the element it is handed with its own editor div, and
    // destroy() removes that div. Hand it a throwaway child so React's
    // managed host survives StrictMode double-mounts and tab switches —
    // otherwise the second init renders into a detached node (blank editor).
    const mount = document.createElement('div')
    host.appendChild(mount)

    let muya: Muya | null = null
    let alive = true

    function onSelChange() {
      const sel = readDomSelection()
      setSelection(sel)
      onSelection(sel)

      if (useSettings.getState().typewriterMode) {
        clearTimeout(typeTimer)
        typeTimer = setTimeout(() => {
          const el = window.getSelection()?.anchorNode?.parentElement
          el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }, 200)
      }
      scheduleGhost()
    }

    function emitChange() {
      if (!muya) return
      // Data URLs are display-only — the store/save path keeps user paths.
      const md = stripImageDataUrls(muya.getMarkdown())
      lastEmitted.current = md
      onInput(md, muya.getTOC())
    }

    const debouncedEmit = () => {
      clearTimeout(emitTimer)
      emitTimer = setTimeout(emitChange, 80)
    }

    // Image paste: clipboard images are saved to `<doc>_assets/` and inserted
    // as portable relative Markdown. Needs a saved document (a home on disk).
    const MIME_EXT: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
    }
    function requireDocDir(): string | null {
      const docPath = useTabs.getState().tabs.find((t) => t.id === tab.id)?.path
      if (!docPath) {
        useToast.getState().show('Save the document first (⌘S) to attach images')
        return null
      }
      return docPath.split(/[\\/]/).slice(0, -1).join('/')
    }
    // muya can't parse <...> destinations, hence encodeURI. The editor renders
    // data: URLs (relative paths can't load) — transform before inserting so
    // the image shows immediately; emitChange strips back to the relative path.
    const insertImageMarkdown = (rel: string) => {
      const docPath = useTabs.getState().tabs.find((t) => t.id === tab.id)?.path
      const md = `![image](${encodeURI(rel)})`
      void addImageDataUrls(md, docPath ?? null)
        .catch(() => md)
        .then((rendered) => insertText(rendered))
    }

    /** Import a user-consented source file into the doc assets, then insert. */
    function importFile(docDir: string, src: string) {
      // A paste/drop is user consent — allow the source, then let imageImport
      // pass its own guard.
      void tauri
        .fsAllow(src)
        .then(() => tauri.imageImport(docDir, src))
        .then(insertImageMarkdown)
        .catch((err) => useToast.getState().show(`Image paste: ${err}`))
    }

    /**
     * File paths for copied images, from every clipboard shape file managers
     * use: uri-list lines, GNOME's `copy\Nfile://…`, or a bare path in
     * text/plain (WebKitGTK often exposes ONLY the last one).
     */
    function imagePathsFromClipboard(e: ClipboardEvent): string[] {
      const raw = [
        e.clipboardData?.getData('text/uri-list') ?? '',
        e.clipboardData?.getData('x-special/gnome-copied-files') ?? '',
        e.clipboardData?.getData('text/plain') ?? '',
      ].join('\n')
      const ext = /\.(png|jpe?g|gif|webp|svg)$/i
      const out = new Set<string>()
      for (const line of raw.split(/[\r\n]+/)) {
        const trimmed = line.trim()
        if (!trimmed || /^copy$/i.test(trimmed)) continue
        const path = trimmed.startsWith('file://')
          ? trimmed.slice('file://'.length)
          : trimmed
        if (!/^[A-Za-z]:?[\\/]/.test(path) || !ext.test(path)) continue
        try {
          out.add(decodeURIComponent(path))
        } catch {
          out.add(path)
        }
      }
      return [...out]
    }

    function onPaste(e: ClipboardEvent) {
      const items = [...(e.clipboardData?.items ?? [])]
      const imageItem = items.find((i) => MIME_EXT[i.type])
      const imagePaths = imagePathsFromClipboard(e)
      const hasText = !!e.clipboardData?.getData('text/plain')

      // Plain text paste (no image payload): never intercept — let Muya work.
      if (!imageItem && imagePaths.length === 0 && hasText) return
      e.preventDefault()
      e.stopPropagation()
      const docDir = requireDocDir()
      if (!docDir) return

      // Copied image FILES (file manager, desktop) — import each into assets.
      if (imagePaths.length > 0) {
        imagePaths.forEach((src) => importFile(docDir, src))
        return
      }

      if (!imageItem) {
        // WebKitGTK hides system-clipboard BITMAPS from the DOM — ask the OS.
        void tauri
          .pasteImage(docDir)
          .then((rel) => {
            if (rel) insertImageMarkdown(rel)
            else useToast.getState().show('No image on the clipboard')
          })
          .catch((err) => useToast.getState().show(`Image paste: ${err}`))
        return
      }

      const file = (imageItem as DataTransferItem).getAsFile()
      if (!file) {
        // getAsFile() null (WebKitGTK): OS clipboard fallback.
        void tauri
          .pasteImage(docDir)
          .then((rel) => {
            if (rel) insertImageMarkdown(rel)
            else useToast.getState().show('Could not read the clipboard image')
          })
          .catch((err) => useToast.getState().show(`Image paste: ${err}`))
        return
      }
      const ext = MIME_EXT[(imageItem as DataTransferItem).type]
      void file
        .arrayBuffer()
        .then(async (buf) => {
          const rel = await tauri.imageSaveBytes(docDir, ext, new Uint8Array(buf))
          insertImageMarkdown(rel)
        })
        .catch((err) => useToast.getState().show(`Image paste: ${err}`))
    }

    // Dropped image files arrive via the webview-level drag-drop event, which
    // App forwards here as `notepad:drop-image`.
    function onDropImage(e: Event) {
      const src = (e as CustomEvent<string>).detail
      const docDir = requireDocDir()
      if (!docDir) return
      // The drop is user consent — allow the source path, then import.
      void tauri
        .fsAllow(src)
        .then(() => tauri.imageImport(docDir, src))
        .then(insertImageMarkdown)
        .catch((err) => useToast.getState().show(`Image import: ${err}`))
    }

    // Ctrl+C/X/A handled here so clipboard keys work regardless of WebKitGTK's
    // native bindings (copy was dead on this build). Host-scoped: keys in the
    // chat input, find bar, and dialogs keep their normal field behavior.
    // Paste (Ctrl+V) is left native — WebKit delivers it with the clipboard
    // payload and Muya + onPaste handle it, images included.
    function onCopyKey(e: KeyboardEvent) {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      const op = { c: 'copy', x: 'cut', a: 'selectAll' }[e.key.toLowerCase()] as
        | 'copy'
        | 'cut'
        | 'selectAll'
        | undefined
      if (!op) return
      e.preventDefault()
      e.stopPropagation()
      editOp(op)
    }

    function teardown() {
      alive = false
      hostRef.current?.removeEventListener('paste', onPaste, true)
      hostRef.current?.removeEventListener('keydown', onCopyKey, true)
      window.removeEventListener('notepad:drop-image', onDropImage)
      detachGhostText()
      clearTimeout(emitTimer)
      clearTimeout(typeTimer)
      if (muya) {
        muya.off('json-change', debouncedEmit)
        muya.off('selection-change', onSelChange)
      }
      registerMuya(null)
      setActiveDocPath(null)
      muya?.destroy() // removes Muya's own editor div from the host
      mount.remove() // no-op after destroy; guards a failed init
      muyaRef.current = null
    }

    // Relative image srcs become data: URLs for RENDERING only — muya cannot
    // load paths from the page origin, and its failed-image state sticks.
    void addImageDataUrls(tab.markdown, tab.path).then((displayMarkdown) => {
      if (!alive) return
      const instance = new Muya(mount, {
        markdown: displayMarkdown,
        footnote: true,
        math: true,
        superSubScript: true,
        spellcheckEnabled: false,
        frontMatter: true,
      })
      instance.init()
      muya = instance
      muyaRef.current = instance
      registerMuya(instance)
      lastEmitted.current = tab.markdown
      setActiveDocPath(tab.path)
      instance.on('json-change', debouncedEmit)
      instance.on('selection-change', onSelChange)
    })

    host.addEventListener('paste', onPaste, true)
    host.addEventListener('keydown', onCopyKey, true)
    window.addEventListener('notepad:drop-image', onDropImage)

    return teardown
    // Editor is created once per tab mount; content flows in via the sync effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  // --- external content changes (file open/reload/AI doc ops) ---
  useEffect(() => {
    let gone = false
    if (tab.markdown !== lastEmitted.current) {
      lastEmitted.current = tab.markdown
      void addImageDataUrls(tab.markdown, tab.path).then((displayMarkdown) => {
        if (!gone) muyaRef.current?.setContent(displayMarkdown)
      })
    }
    return () => {
      gone = true
    }
  }, [tab.id, tab.markdown, tab.path])

  // --- option syncing ---
  useEffect(() => {
    if (muyaRef.current) muyaRef.current.options.focusMode = focusMode
  }, [focusMode])
  useEffect(() => {
    if (muyaRef.current) muyaRef.current.options.fontSize = fontSize
  }, [fontSize])
  useEffect(() => {
    setActiveDocPath(tab.path)
  }, [tab.path])

  // --- ghost text ---
  useEffect(() => {
    if (!ghostText) {
      detachGhostText()
      return
    }
    attachGhostText({
      enabled: () => useSettings.getState().ghostText,
      request: requestGhost,
      insert: (t) => {
        insertText(t)
      },
    })
    return () => detachGhostText()
  }, [ghostText])

  return <div className="editor-host" ref={hostRef} />
}
