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
    const onPaste = (e: ClipboardEvent) => {
      const items = [...(e.clipboardData?.items ?? [])]
      const imageItem = items.find((i) => MIME_EXT[i.type])
      const hasText = !!e.clipboardData?.getData('text/plain')
      // Copied FILE (from a file manager) rides as a URI list, not a File.
      const uriList = e.clipboardData?.getData('text/uri-list') ?? ''
      const imageUri = uriList
        .split(/\r?\n/)
        .map((u) => u.trim())
        .find((u) => /^file:\/\/.+\.(png|jpe?g|gif|webp|svg)$/i.test(u))

      // Plain text paste: never intercept. Nothing promising: let Muya work.
      if (!imageItem && !imageUri && hasText) return
      if (!imageItem && !imageUri) {
        // WebKitGTK hides system-clipboard images from the DOM — ask the OS.
        const docDir = requireDocDir()
        if (!docDir) return
        e.preventDefault()
        e.stopPropagation()
        void tauri
          .pasteImage(docDir)
          .then((rel) => {
            if (rel) insertImageMarkdown(rel)
            else useToast.getState().show('No image on the clipboard')
          })
          .catch((err) => useToast.getState().show(`Image paste: ${err}`))
        return
      }

      e.preventDefault()
      e.stopPropagation()
      const docDir = requireDocDir()
      if (!docDir) return
      if (imageUri) {
        // file:// URI → copy the file into the doc's assets.
        const src = decodeURIComponent(imageUri.replace(/^file:\/\//, ''))
        void tauri
          .imageImport(docDir, src)
          .then(insertImageMarkdown)
          .catch((err) => useToast.getState().show(`Image paste: ${err}`))
        return
      }
      const item = imageItem as DataTransferItem
      const file = item.getAsFile()
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
      const ext = MIME_EXT[item.type]
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
      void tauri
        .imageImport(docDir, src)
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
