import { describe, expect, it } from 'vitest'
import { flushPendingEmit, registerEmitFlush } from '../src/editor/editBridge'

/**
 * The emit-flush registry is the data-loss guard for MuyaEditor's 80ms
 * debounced emit: store actions that read or destroy tab state (close,
 * switch, quit) flush through it first.
 */
describe('emit-flush registry', () => {
  it('flushes through the registered callback until it is unregistered', () => {
    let calls = 0
    registerEmitFlush(() => {
      calls++
    })
    flushPendingEmit()
    flushPendingEmit()
    expect(calls).toBe(2)
    registerEmitFlush(null)
    flushPendingEmit()
    expect(calls).toBe(2) // unregistered = no-op, never a stale-editor write
  })
})
