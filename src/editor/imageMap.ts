import { tauri } from '../lib/tauri'

/**
 * Muya cannot load relative image paths (the page origin has no filesystem,
 * and the asset:// protocol proved unreliable on WebKitGTK — "Load image
 * failed" before any fix could land). So the markdown Muya RENDERS carries
 * data: URLs, while everything we store/emit keeps the portable relative
 * paths the user wrote.
 *
 * addImageDataUrls → into the editor; stripImageDataUrls → out of it.
 * Two src shapes: markdown `![alt](src)` AND raw `<img src="…">` (muya's
 * resize tool persists width by converting to an inline HTML img).
 */

const dataUrlCache = new Map<string, Promise<string>>() // abs path → data url
const toSource = new Map<string, string>() // data url → original src token

const MD_IMAGE_RE = /(!\[[^\]]*\]\()([^)\s]+)(\))/g
const HTML_IMG_RE = /(<img\s[^>]*?src=")([^"]+)(")/g
const MD_DATA_URL_RE = /!\[[^\]]*\]\(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+\)/g
const HTML_DATA_URL_RE = /(<img\s[^>]*?src=")(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)(")/g

function isLocalPath(src: string): boolean {
  return !/^(https?|data|blob|asset):/i.test(src)
}

function dataUrlFor(src: string, docDir: string): Promise<string> | null {
  if (!isLocalPath(src)) return null
  let path = src
  try {
    path = decodeURIComponent(path) // markdown carries URL-encoded paths
  } catch {
    /* keep raw */
  }
  const abs = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
    ? path
    : `${docDir}${docDir ? '/' : ''}${path}`
  let p = dataUrlCache.get(abs)
  if (!p) {
    p = tauri.imageData(abs)
    dataUrlCache.set(abs, p)
    p.catch(() => dataUrlCache.delete(abs)) // retried next render (file may appear later)
  }
  return p
}

export async function addImageDataUrls(markdown: string, docPath: string | null): Promise<string> {
  if (!docPath || !markdown.includes('](') && !markdown.includes('<img')) return markdown
  const docDir = docPath.split(/[\\/]/).slice(0, -1).join('/')
  const pending = new Map<string, Promise<string>>() // original src → data url
  for (const re of [MD_IMAGE_RE, HTML_IMG_RE]) {
    for (const match of markdown.matchAll(re)) {
      const src = match[2]
      if (!pending.has(src)) {
        const p = dataUrlFor(src, docDir)
        if (p) pending.set(src, p)
      }
    }
  }
  if (pending.size === 0) return markdown

  const results = await Promise.allSettled([...pending.values()])
  const bySrc = new Map([...pending.keys()].map((src, i) => [src, results[i]]))
  const swap = (src: string): string | null => {
    const r = bySrc.get(src)
    if (!r || r.status === 'rejected') return null
    const url = r.value
    toSource.set(url, src)
    return url
  }
  return markdown
    .replace(MD_IMAGE_RE, (full, alt: string, src: string, tail: string) => {
      const url = swap(src)
      return url ? `${alt}${url}${tail}` : full
    })
    .replace(HTML_IMG_RE, (full, head: string, src: string, tail: string) => {
      const url = swap(src)
      return url ? `${head}${url}${tail}` : full
    })
}

/** Reverse the transform: saved/edited markdown keeps the user's paths. */
export function stripImageDataUrls(markdown: string): string {
  if (!markdown.includes('data:image')) return markdown
  return markdown
    .replace(MD_DATA_URL_RE, (full) => {
      const url = full.slice(full.indexOf('(') + 1, -1)
      const src = toSource.get(url)
      return src ? `![image](${src})` : full
    })
    .replace(HTML_DATA_URL_RE, (full, head: string, url: string, tail: string) => {
      const src = toSource.get(url)
      return src ? `${head}${src}${tail}` : full
    })
}
