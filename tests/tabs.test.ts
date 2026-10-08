import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../src/types'

/**
 * The tabs store is the app's data-loss surface: autosave, close, dirty
 * tracking. These tests pin the invariants that used to be broken.
 */

// In-memory fake of the Rust boundary.
const writes: { path: string; contents: string }[] = []
const mocks = vi.hoisted(() => ({
  pickSaveFile: vi.fn<(name: string) => Promise<string | null>>(),
}))

vi.mock('../src/lib/tauri', () => ({
  tauri: {
    fsAllow: vi.fn(async () => {}),
    readFile: vi.fn(async (path: string) => `content of ${path}`),
    writeFile: vi.fn(async (path: string, contents: string, _expectedMtime?: number | null) => {
      if (path.includes('fail')) throw new Error('disk full')
      writes.push({ path, contents })
      return 4242
    }),
    statMtime: vi.fn(async () => 1234),
    recentPush: vi.fn(async () => {}),
    saveRecovery: vi.fn(async (title: string) => `/recovery/${title}.md`),
  },
  pickSaveFile: mocks.pickSaveFile,
}))

import { useTabs } from '../src/stores/tabs'
import { registerEmitFlush } from '../src/editor/editBridge'

function seedTab(partial: Partial<Tab>): Tab {
  const tab: Tab = {
    id: crypto.randomUUID(),
    path: null,
    title: 'untitled',
    dirty: false,
    markdown: '',
    mtime: null,
    ...partial,
  }
  useTabs.setState((s) => ({ tabs: [...s.tabs, tab] }))
  return tab
}

beforeEach(() => {
  vi.useFakeTimers()
  writes.length = 0
  mocks.pickSaveFile.mockReset()
  useTabs.setState({ tabs: [], activeId: null, banner: null, closed: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('autosave', () => {
  it('writes a named tab 500ms after the last edit', async () => {
    const tab = seedTab({ path: '/ws/a.md', title: 'a.md', markdown: 'old' })
    useTabs.getState().setContent(tab.id, 'new text')
    expect(writes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(writes).toEqual([{ path: '/ws/a.md', contents: 'new text' }])
    expect(useTabs.getState().tabs[0].dirty).toBe(false)
  })

  it('autosave of an untitled tab does NOT pop a save dialog', async () => {
    const tab = seedTab({ markdown: 'draft' })
    useTabs.setState({ activeId: tab.id })
    useTabs.getState().setContent(tab.id, 'draft 2')
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.pickSaveFile).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
    // still dirty — the work is not silently "saved" anywhere
    expect(useTabs.getState().tabs[0].dirty).toBe(true)
  })

  it('typing in tab B does not cancel tab A pending write', async () => {
    const a = seedTab({ path: '/ws/a.md', title: 'a.md', markdown: 'a' })
    const b = seedTab({ path: '/ws/b.md', title: 'b.md', markdown: 'b' })
    useTabs.getState().setContent(a.id, 'a2')
    await vi.advanceTimersByTimeAsync(300)
    useTabs.getState().setContent(b.id, 'b2')
    // 500ms after A's edit: A must have been written even though B edited at 300.
    await vi.advanceTimersByTimeAsync(200)
    expect(writes.some((w) => w.path === '/ws/a.md')).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(writes.some((w) => w.path === '/ws/b.md')).toBe(true)
  })

  it('keeps the tab dirty when edits land while a save is in flight', async () => {
    // Deferred writeFile so we can mutate mid-save.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { tauri } = await import('../src/lib/tauri')
    vi.mocked(tauri.writeFile).mockImplementationOnce(() => gate as unknown as Promise<number>)

    const tab = seedTab({ path: '/ws/a.md', markdown: 'v1' })
    useTabs.getState().setContent(tab.id, 'v2')
    const saving = useTabs.getState().saveById(tab.id)
    useTabs.getState().setContent(tab.id, 'v3 typed during save')
    release()
    await saving
    expect(useTabs.getState().tabs[0].dirty).toBe(true) // v3 still unsaved
    await vi.advanceTimersByTimeAsync(500)
    expect(writes.some((w) => w.contents === 'v3 typed during save')).toBe(true)
  })
})

describe('close', () => {
  it('keeps the tab open when the save fails', async () => {
    const tab = seedTab({ path: '/ws/fail.md', title: 'fail.md', markdown: 'x', dirty: true })
    await useTabs.getState().close(tab.id)
    expect(useTabs.getState().tabs.some((t) => t.id === tab.id)).toBe(true)
  })

  it('closes a named tab after a successful save', async () => {
    const tab = seedTab({ path: '/ws/ok.md', markdown: 'x', dirty: true })
    await useTabs.getState().close(tab.id)
    expect(useTabs.getState().tabs.some((t) => t.id === tab.id)).toBe(false)
    expect(writes).toEqual([{ path: '/ws/ok.md', contents: 'x' }])
  })

  it('closing a dirty untitled tab discards it without a save dialog', async () => {
    const active = seedTab({ path: '/ws/active.md', title: 'active.md', markdown: 'active content' })
    const bg = seedTab({ path: null, title: 'untitled', markdown: 'bg draft', dirty: true })
    useTabs.setState({ activeId: active.id })
    await useTabs.getState().close(bg.id)
    expect(useTabs.getState().tabs.some((t) => t.id === bg.id)).toBe(false)
    expect(useTabs.getState().tabs.some((t) => t.id === active.id)).toBe(true)
    expect(mocks.pickSaveFile).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('a discarded untitled tab does not land in reopen-closed-tab', async () => {
    const tab = seedTab({ markdown: 'scratch', dirty: true })
    await useTabs.getState().close(tab.id)
    expect(useTabs.getState().closed).toEqual([])
  })
})

describe('saveActive on untitled tab', () => {
  it('manual save routes through Save-As with the right content', async () => {
    const tab = seedTab({ markdown: 'manual', dirty: true })
    useTabs.setState({ activeId: tab.id })
    mocks.pickSaveFile.mockResolvedValue('/ws/manual.md')
    await useTabs.getState().saveActive()
    expect(writes).toEqual([{ path: '/ws/manual.md', contents: 'manual' }])
    expect(useTabs.getState().tabs[0].path).toBe('/ws/manual.md')
  })
})

describe('flushAll (quit)', () => {
  it('writes named dirty tabs and recovers untitled ones', async () => {
    seedTab({ path: '/ws/a.md', markdown: 'a', dirty: true })
    seedTab({ path: '/ws/clean.md', markdown: 'clean', dirty: false })
    seedTab({ title: 'scratch', markdown: 'untitled work', dirty: true })
    const { recovered, failed } = await useTabs.getState().flushAll()
    expect(writes).toEqual([{ path: '/ws/a.md', contents: 'a' }])
    expect(recovered).toEqual(['/recovery/scratch.md'])
    expect(failed).toEqual([])
  })

  it('reports titles whose save failed instead of swallowing them', async () => {
    seedTab({ path: '/ws/fail.md', title: 'fail.md', markdown: 'x', dirty: true })
    const { failed, recovered } = await useTabs.getState().flushAll()
    expect(failed).toEqual(['fail.md'])
    expect(recovered).toEqual([])
  })
})

describe('mtime conflict guard', () => {
  it('blocks a stale save, keeps the buffer dirty, and flags the tab stale', async () => {
    const { tauri } = await import('../src/lib/tauri')
    vi.mocked(tauri.writeFile).mockRejectedValueOnce(new Error('mtime-conflict: file changed on disk'))
    const tab = seedTab({ path: '/ws/a.md', title: 'a.md', markdown: 'mine', dirty: true })
    useTabs.setState({ activeId: tab.id })
    expect(await useTabs.getState().saveById(tab.id)).toBe('failed')
    expect(useTabs.getState().tabs[0].dirty).toBe(true) // buffer kept
    expect(useTabs.getState().banner).toBe('This file changed on disk.')
    // Background stale tab surfaces the banner when activated.
    useTabs.setState({ banner: null })
    useTabs.getState().setActive(tab.id)
    expect(useTabs.getState().banner).toBe('This file changed on disk.')
  })

  it('saveActiveAs passes the existing file mtime as the conflict guard', async () => {
    const { tauri } = await import('../src/lib/tauri')
    const tab = seedTab({ markdown: 'x', dirty: true })
    useTabs.setState({ activeId: tab.id })
    mocks.pickSaveFile.mockResolvedValue('/ws/exists.md')
    await useTabs.getState().saveActiveAs()
    // statMtime's 1234 went out as expectedMtime — an unopened file the user
    // is overwriting is protected too.
    expect(vi.mocked(tauri.writeFile).mock.calls.at(-1)?.[2]).toBe(1234)
  })

  it('keepMine clears the stale flag and the mtime guard', async () => {
    const { tauri } = await import('../src/lib/tauri')
    vi.mocked(tauri.writeFile).mockRejectedValueOnce(new Error('mtime-conflict: file changed on disk'))
    const tab = seedTab({ path: '/ws/a.md', markdown: 'x', dirty: true, mtime: 5 })
    useTabs.setState({ activeId: tab.id })
    await useTabs.getState().saveById(tab.id)
    useTabs.getState().keepMine(tab.id)
    expect(useTabs.getState().banner).toBeNull()
    expect(useTabs.getState().tabs[0].mtime).toBeNull()
    // Stale flag gone — re-activating shows no banner.
    useTabs.getState().setActive(tab.id)
    expect(useTabs.getState().banner).toBeNull()
    // The next save goes out unguarded (deliberate overwrite).
    await useTabs.getState().saveById(tab.id)
    expect(vi.mocked(tauri.writeFile).mock.calls.at(-1)?.[2]).toBeNull()
  })
})

describe('emit flush (debounced editor tail)', () => {
  it('close flushes the editor tail before saving', async () => {
    const tab = seedTab({ path: '/ws/flush.md', markdown: 'saved part', dirty: true })
    registerEmitFlush(() =>
      useTabs.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, markdown: 'saved part +tail' } : t)),
      })),
    )
    await useTabs.getState().close(tab.id)
    registerEmitFlush(null)
    expect(writes).toEqual([{ path: '/ws/flush.md', contents: 'saved part +tail' }])
  })

  it('tab switch flushes the outgoing tab tail into its own tab', () => {
    const a = seedTab({ path: '/ws/a.md', title: 'a.md' })
    const b = seedTab({ path: '/ws/b.md', title: 'b.md' })
    useTabs.setState({ activeId: a.id })
    registerEmitFlush(() =>
      useTabs.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, markdown: 'a+tail' } : t)),
      })),
    )
    useTabs.getState().setActive(b.id)
    registerEmitFlush(null)
    expect(useTabs.getState().tabs.find((t) => t.id === a.id)?.markdown).toBe('a+tail')
    expect(useTabs.getState().activeId).toBe(b.id)
  })
})

describe('saveActiveAs clash guard', () => {
  it('refuses a path already open in another tab', async () => {
    const other = seedTab({ path: '/ws/taken.md', title: 'taken.md' })
    const tab = seedTab({ markdown: 'x', dirty: true })
    useTabs.setState({ activeId: tab.id })
    mocks.pickSaveFile.mockResolvedValue('/ws/taken.md')
    expect(await useTabs.getState().saveActiveAs()).toBe(false)
    expect(writes).toHaveLength(0)
    expect(useTabs.getState().tabs.find((t) => t.id === tab.id)?.dirty).toBe(true)
    expect(useTabs.getState().tabs.some((t) => t.id === other.id)).toBe(true)
  })
})

describe('self-save echo window', () => {
  it('absorbs repeated fs-changed events from one atomic write', () => {
    const t = useTabs.getState()
    t.noteSelfSave('/ws/a.md')
    expect(t.consumeSelfSave('/ws/a.md')).toBe(true)
    // Stray second event: consume misses, the 1s window catches it.
    expect(t.consumeSelfSave('/ws/a.md')).toBe(false)
    expect(t.wasSelfSaveRecently('/ws/a.md')).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(t.wasSelfSaveRecently('/ws/a.md')).toBe(false)
  })
})
