/**
 * Quit orchestration: flush saves, keep the Rust watchdog fed via a
 * heartbeat, and never exit with unsaved text. Extracted from App.tsx so the
 * refusal/heartbeat/re-entrancy rules are testable without a DOM.
 */

export interface QuitDeps {
  /** Flush debounced editor state + save all dirty tabs. */
  flush: () => Promise<{ failed: string[] }>
  /** Ask Rust to really exit (disarms the watchdog). */
  quit: () => Promise<void>
  /** Disarm the watchdog without exiting (flush refused / quit failed). */
  disarm: () => Promise<void>
  /** Push the force-exit deadline out (called on an interval while flushing). */
  extend: () => Promise<void>
  /** Surfaced when quitting is refused (failed saves). */
  onBlocked: (failed: string[]) => void
}

/** Guard across re-renders/calls: the flush must happen exactly once per quit. */
let quitting = false

/** Test seam: reset the re-entrancy guard between tests. */
export function resetQuitForTests() {
  quitting = false
}

export async function quitFlow(d: QuitDeps) {
  if (quitting) return
  quitting = true
  // Heartbeat: a many-tab flush on slow storage must not be force-killed by
  // the watchdog; a DEAD webview stops extending and is killed on schedule.
  const heartbeat = setInterval(() => void d.extend().catch(() => {}), 1000)
  let failed: string[]
  try {
    ;({ failed } = await d.flush())
  } catch (e) {
    // flushAll itself rejecting is a bug, but the only copy of the text may
    // be in memory — refuse to exit and surface it.
    clearInterval(heartbeat)
    quitting = false
    await d.disarm().catch(() => {})
    d.onBlocked([String(e)])
    return
  }
  clearInterval(heartbeat)
  if (failed.length > 0) {
    // The dirty buffers are the only copy of that text — refuse to exit.
    // quitting resets so the user can retry once the disk problem is fixed.
    quitting = false
    await d.disarm().catch(() => {})
    d.onBlocked(failed)
    return
  }
  const exited = await d
    .quit()
    .then(() => true)
    .catch(() => false)
  if (!exited) {
    quitting = false // quit didn't happen — allow a later retry to flush
    await d.disarm().catch(() => {})
  }
}
