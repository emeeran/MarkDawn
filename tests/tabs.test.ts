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
    writeFile: vi.fn(async (path: string, contents: string) => {
      if (path.includes('fail')) throw new Error('disk full')
      writes.push({ path, contents })
    }),
    recentPush: vi.fn(async () => {}),
    saveRecovery: vi.fn(async (title: string) => `/recovery/${title}.md`),
  },
  pickSaveFile: mocks.pickSaveFile,
}))

import { useTabs } from '../src/stores/tabs'

function seedTab(partial: Partial<Tab>): Tab {
  const tab: Tab = {
    id: crypto.randomUUID(),
    path: null,
    title: 'untitled',
    dirty: false,
    markdown: '',
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
    vi.mocked(tauri.writeFile).mockImplementationOnce(() => gate as Promise<void>)

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

  it('background untitled tab close saves THAT tab, not the active one', async () => {
    const active = seedTab({ path: '/ws/active.md', title: 'active.md', markdown: 'active content' })
    const bg = seedTab({ path: null, title: 'untitled', markdown: 'bg draft', dirty: true })
    useTabs.setState({ activeId: active.id })
    mocks.pickSaveFile.mockResolvedValue('/ws/chosen.md')
    await useTabs.getState().close(bg.id)
    // The dialog saved the *closing* tab's content — not the active tab's.
    expect(writes).toEqual([{ path: '/ws/chosen.md', contents: 'bg draft' }])
    expect(useTabs.getState().tabs.some((t) => t.id === bg.id)).toBe(false)
    expect(useTabs.getState().tabs.some((t) => t.id === active.id)).toBe(true)
  })

  it('cancel on Save-As keeps the dirty untitled tab', async () => {
    const tab = seedTab({ markdown: 'precious', dirty: true })
    mocks.pickSaveFile.mockResolvedValue(null)
    await useTabs.getState().close(tab.id)
    expect(useTabs.getState().tabs.some((t) => t.id === tab.id)).toBe(true)
    expect(useTabs.getState().tabs[0].dirty).toBe(true)
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
    const recovered = await useTabs.getState().flushAll()
    expect(writes).toEqual([{ path: '/ws/a.md', contents: 'a' }])
    expect(recovered).toEqual(['/recovery/scratch.md'])
  })
})
