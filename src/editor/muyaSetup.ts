import {
  CodeBlockLanguageSelector,
  EmojiSelector,
  FootnoteTool,
  ImageEditTool,
  ImageResizeBar,
  ImageToolBar,
  InlineFormatToolbar,
  LinkTools,
  Muya,
  ParagraphFrontButton,
  ParagraphFrontMenu,
  ParagraphQuickInsertMenu,
  PreviewToolBar,
  TableColumnToolbar,
  TableDragBar,
  TableRowColumMenu,
} from '@muyajs/core'
import '@muyajs/core/lib/core.css'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useToast } from '../stores/toast'

// Path of the active document — set by MuyaEditor, used for relative image paths.
let activeDocPath: string | null = null

export function setActiveDocPath(path: string | null) {
  activeDocPath = path
}

// Plugin registration is global and idempotent (Muya.use on the class).
let registered = false

export function registerMuyaPlugins() {
  if (registered) return
  registered = true
  Muya.use(EmojiSelector)
  Muya.use(FootnoteTool)
  Muya.use(InlineFormatToolbar)
  Muya.use(ImageToolBar)
  Muya.use(ImageResizeBar)
  Muya.use(CodeBlockLanguageSelector)
  Muya.use(LinkTools, {
    jumpClick: (linkInfo: { href?: string }) => {
      const href = linkInfo?.href
      if (href && /^https?:\/\//.test(href)) {
        void openUrl(href).catch(() => useToast.getState().show(`Cannot open ${href}`))
      }
    },
  })
  Muya.use(ImageEditTool, {
    // Insert an image by picking a file; store a doc-relative path so the
    // Markdown stays portable. Display-time resolution happens in MuyaEditor.
    imagePathPicker: async () => {
      const file = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] }],
      })
      if (!file || typeof file !== 'string') return ''
      return relativeToActiveDoc(file)
    },
    imageAction: async () => {
      useToast.getState().show('Use the image toolbar → pick an image file')
      return ''
    },
  })
  Muya.use(ParagraphFrontButton)
  Muya.use(ParagraphFrontMenu)
  Muya.use(ParagraphQuickInsertMenu)
  Muya.use(TableColumnToolbar)
  Muya.use(TableDragBar)
  Muya.use(TableRowColumMenu)
  Muya.use(PreviewToolBar)
}

/** Best-effort relative path from the active document's directory. */
function relativeToActiveDoc(absolute: string): string {
  if (!activeDocPath) return absolute
  const sep = activeDocPath.includes('\\') ? '\\' : '/'
  const docDir = activeDocPath.split(sep).slice(0, -1)
  const parts = absolute.split(/[\\/]/)
  let i = 0
  while (i < docDir.length && i < parts.length - 1 && docDir[i] === parts[i]) i++
  const rel = [...Array(Math.max(0, docDir.length - i)).fill('..'), ...parts.slice(i)].join('/')
  return rel || absolute
}
