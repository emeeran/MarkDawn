import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * imageMap swaps relative image paths for data: URLs before Muya renders and
 * strips them back out on the way to disk. The round trip must preserve the
 * author's markdown byte-for-byte, and the caches must stay bounded.
 */

vi.mock('../src/lib/tauri', () => ({
  tauri: {
    // Real base64 payload — the strip regexes only match base64 chars.
    imageData: vi.fn(async (path: string) => {
      if (path.includes('missing')) throw new Error('no such file')
      return `data:image/png;base64,${btoa(path)}`
    }),
  },
}))

import { addImageDataUrls, stripImageDataUrls } from '../src/editor/imageMap'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('image data-url round trip', () => {
  it('restores the original markdown including alt text', async () => {
    const md = 'a\n\n![my dog](dog.png)\n\n<img src="cat.png" width="40">\n'
    const rendered = await addImageDataUrls(md, '/home/u/doc')
    expect(rendered).toContain('data:image/png;base64,')
    expect(stripImageDataUrls(rendered)).toBe(md)
  })

  it('leaves remote and data images alone', async () => {
    const md = '![x](https://e.com/i.png) ![y](data:image/png;base64,AAA)'
    expect(await addImageDataUrls(md, '/d')).toBe(md)
  })

  it('keeps the path when the file read fails', async () => {
    const md = '![gone](missing.png)'
    const rendered = await addImageDataUrls(md, '/d')
    expect(rendered).toBe(md)
    expect(stripImageDataUrls(rendered)).toBe(md)
  })

  it('round-trips multiple references to the same image', async () => {
    const md = '![a](x.png) and ![a](x.png) again'
    const rendered = await addImageDataUrls(md, '/d')
    expect(stripImageDataUrls(rendered)).toBe(md)
  })

  it('does nothing without a document path', async () => {
    const md = '![a](x.png)'
    expect(await addImageDataUrls(md, null)).toBe(md)
  })
})
