import { Muya } from '@muyajs/core'
import { useEffect, useRef } from 'react'
import { convertFileSrc } from '../lib/tauri'
import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'
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
