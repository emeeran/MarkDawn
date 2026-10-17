import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quitFlow, resetQuitForTests, type QuitDeps } from '../src/lib/quit'

/**
 * The quit contract: flush everything, never exit with unsaved text, keep
 * the Rust force-exit watchdog fed while a flush runs, and disarm it when
 * quitting is refused. This used to live untestable inside App.tsx — and the
 * watchdog used to destroy the very buffers a refused quit protected.
 */

function deps(over: Partial<QuitDeps> = {}): QuitDeps {
  return {
    flush: vi.fn(async () => ({ failed: [] as string[] })),
    quit: vi.fn(async () => {}),
    disarm: vi.fn(async () => {}),
    extend: vi.fn(async () => {}),
    onBlocked: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetQuitForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('quitFlow', () => {
  it('flushes, then quits on success', async () => {
    const d = deps()
    await quitFlow(d)
    expect(d.flush).toHaveBeenCalledOnce()
    expect(d.quit).toHaveBeenCalledOnce()
    expect(d.disarm).not.toHaveBeenCalled()
    expect(d.onBlocked).not.toHaveBeenCalled()
  })

  it('refuses to quit on failed saves: disarms the watchdog and blocks', async () => {
    const d = deps({ flush: vi.fn(async () => ({ failed: ['a.md'] })) })
    await quitFlow(d)
    expect(d.quit).not.toHaveBeenCalled()
    expect(d.disarm).toHaveBeenCalledOnce()
    expect(d.onBlocked).toHaveBeenCalledWith(['a.md'])
    // The refusal resets the guard — the user can retry after fixing disk.
    const retry = deps()
    await quitFlow(retry)
    expect(retry.quit).toHaveBeenCalledOnce()
  })

  it('keeps the watchdog fed via extend heartbeats during a long flush', async () => {
    let resolveFlush!: (v: { failed: string[] }) => void
    const extend = vi.fn(async () => {})
    const d = deps({
      extend,
      flush: vi.fn(() => new Promise<{ failed: string[] }>((r) => (resolveFlush = r))),
    })
    const quitting = quitFlow(d)
    await vi.advanceTimersByTimeAsync(3500)
    expect(extend.mock.calls.length).toBeGreaterThanOrEqual(3)
    resolveFlush({ failed: [] })
    await quitting
    expect(d.quit).toHaveBeenCalledOnce()
  })

  it('is re-entrant: a second call while a quit is in flight is a no-op', async () => {
    let resolveFlush!: (v: { failed: string[] }) => void
    const d = deps({
      flush: vi.fn(() => new Promise<{ failed: string[] }>((r) => (resolveFlush = r))),
    })
    void quitFlow(d)
    await quitFlow(deps()) // second quit-requested while the first runs
    expect(d.flush).toHaveBeenCalledOnce()
    resolveFlush({ failed: [] })
  })

  it('disarms and blocks when the flush itself throws', async () => {
    const d = deps({
      flush: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await quitFlow(d)
    expect(d.disarm).toHaveBeenCalledOnce()
    expect(d.onBlocked).toHaveBeenCalled()
    expect(d.quit).not.toHaveBeenCalled()
  })

  it('disarms when quit_now itself fails, allowing a later retry', async () => {
    const d = deps({
      quit: vi.fn(async () => {
        throw new Error('exit failed')
      }),
    })
    await quitFlow(d)
    expect(d.disarm).toHaveBeenCalledOnce()
    const retry = deps()
    await quitFlow(retry)
    expect(retry.quit).toHaveBeenCalledOnce()
  })
})
