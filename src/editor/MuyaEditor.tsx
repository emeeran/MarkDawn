import { Muya } from '@muyajs/core'
import { useEffect, useRef } from 'react'
import { convertFileSrc, tauri } from '../lib/tauri'
import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'
import { useToast } from '../stores/toast'
import type { ITocItem } from '@muyajs/core'
import type { SelectionInfo, Tab } from '../types'
import { readDomSelection, setSelection } from '../ai/selection'
import { insertText, registerMuya } from './editBridge'
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
    const muya = new Muya(mount, {
      markdown: tab.markdown,
      footnote: true,
      math: true,
      superSubScript: true,
      spellcheckEnabled: false,
      frontMatter: true,
    })
    muya.init()
    muyaRef.current = muya
    registerMuya(muya)
    lastEmitted.current = tab.markdown
    setActiveDocPath(tab.path)

    const emitChange = () => {
      const md = muya.getMarkdown()
      lastEmitted.current = md
      onInput(md, muya.getTOC())
    }
    const debouncedEmit = () => {
      clearTimeout(emitTimer)
      emitTimer = setTimeout(emitChange, 80)
    }

    const onSelChange = () => {
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

    muya.on('json-change', debouncedEmit)
    muya.on('selection-change', onSelChange)

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
    const insertImageMarkdown = (rel: string) => insertText(`![image](<${rel}>)`)

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

    const onPaste = (e: ClipboardEvent) => {
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
    host.addEventListener('paste', onPaste, true)
    // Dropped image files arrive via the webview-level drag-drop event, which
    // App forwards here as `notepad:drop-image`.
    const onDropImage = (e: Event) => {
      const src = (e as CustomEvent<string>).detail
      const docPath = useTabs.getState().tabs.find((t) => t.id === tab.id)?.path
      if (!docPath) {
        useToast.getState().show('Save the document first (⌘S) to attach images')
        return
      }
      const docDir = docPath.split(/[\\/]/).slice(0, -1).join('/')
      // The drop is user consent — allow the source path, then import.
      void tauri
        .fsAllow(src)
        .then(() => tauri.imageImport(docDir, src))
        .then((rel) => insertText(`![image](<${rel}>)`))
        .catch((err) => useToast.getState().show(`Image import: ${err}`))
    }
    window.addEventListener('notepad:drop-image', onDropImage)

    // Resolve relative/absolute image paths to asset:// URLs for display.
    // Markdown source keeps portable paths; only the DOM src is rewritten.
    const resolveImg = (img: HTMLImageElement) => {
      const src = img.getAttribute('src') ?? ''
      if (!src || /^(https?|data|blob|asset):/i.test(src)) return
      if (img.dataset.resolved === src) return
      const docPath = useTabs.getState().tabs.find((t) => t.id === tab.id)?.path
      if (!docPath) return
      const dir = docPath.split(/[\\/]/).slice(0, -1).join('/')
      const abs = src.startsWith('/') || /^[A-Za-z]:[\\/]/.test(src) ? src : `${dir}${dir ? '/' : ''}${src}`
      img.dataset.resolved = src
      img.src = convertFileSrc(abs)
    }
    const observer = new MutationObserver(() => {
      hostRef.current?.querySelectorAll('img').forEach(resolveImg)
    })
    observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })

    return () => {
      observer.disconnect()
      host.removeEventListener('paste', onPaste, true)
      window.removeEventListener('notepad:drop-image', onDropImage)
      detachGhostText()
      clearTimeout(emitTimer)
      clearTimeout(typeTimer)
      muya.off('json-change', debouncedEmit)
      muya.off('selection-change', onSelChange)
      registerMuya(null)
      setActiveDocPath(null)
      muya.destroy() // removes Muya's own editor div from the host
      mount.remove() // no-op after destroy; guards a failed init
      muyaRef.current = null
    }
    // Editor is created once per tab mount; content flows in via the sync effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  // --- external content changes (file open/reload/AI doc ops) ---
  useEffect(() => {
    const muya = muyaRef.current
    if (!muya) return
    if (tab.markdown !== lastEmitted.current) {
      lastEmitted.current = tab.markdown
      muya.setContent(tab.markdown)
    }
  }, [tab.id, tab.markdown])

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
