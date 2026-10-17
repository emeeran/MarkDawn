# Production Readiness Audit — 2026-10-18

> Supersedes the 2026-09-14 audit (archived with this run in
> `.pipeline/archive/2026-09-run/`). That audit's blockers (CSP, asset scope,
> FsGuard confinement, flush-on-quit, tabs-store tests, CI) were fixed; this
> run re-audited the tree after the cleanup pipeline (phases 0–3).

Scope: full repo review by six independent audit passes (correctness/error-handling,
security, config/environment, observability, testing/CI, operational readiness).
Findings merged and deduplicated; severity is the highest assigned by any pass.
All findings verified in surrounding code by the auditing pass.

## Summary

**Ready with fixes.** The durability and security core is genuinely solid:
atomic writes with fsync, keychain-only secrets (verified end to end — no key
ever reaches settings.json or the frontend), array-built subprocess argv
everywhere, a linear-time regex engine behind hard caps, DOMPurify-sanitized
chat/editor rendering under a `script-src 'self'` CSP, and corrupt-store
preservation. What is not solid is the **quit path**: the force-exit watchdog
can destroy the very buffers flush-on-quit exists to protect (B1), and two
adjacent failures swallow recovery errors (H1). All three are small, targeted
fixes in `lifecycle.rs` / `App.tsx` / `tabs.ts`. After those land and the test
contract gap (H6) is pinned, this ships.

## Blockers (must fix before distribution)

- [ ] `src-tauri/src/lifecycle.rs:53-63` + `src/App.tsx:62-72` — **the quit
  watchdog defeats the refuse-to-exit guard.** When `flushAll()` reports
  failures, `quitFlow` shows "Not quitting — save failed" and deliberately
  never calls `quit_now`. But the only thing that disarms the 3 s force-exit
  watchdog is `quit_now` — so a still-armed watchdog calls `exit(1)` three
  seconds later, killing the app with the unsaved buffers the toast claimed
  were protected. Same path when `quitNow` itself rejects. Fix: a `disarm`
  command (or disarm-before-emit, re-arm inside `quit_now`).

## High priority

- [ ] `src/stores/tabs.ts:338-344` — the last-resort recovery write for a
  dirty **untitled** tab is `catch {}`-swallowed and never pushed into
  `failed`, so quit proceeds and the only copy of that text dies even though
  the named-tab path would have refused to exit. Push into `failed`.
- [ ] `src/stores/tabs.ts:196-206` — typing during an in-flight autosave makes
  `markSaved` skip the mtime update (guard: content changed during the await).
  Disk now carries our own write's mtime; the tab still holds the pre-save
  one — the next autosave fails `check_mtime` against **our own write**, a
  false "mtime-conflict", and the autosave chain halts until manual reload.
  Every keystroke-during-save reproduces it.
- [ ] `src-tauri/src/tts.rs:201-287` vs `src/ai/tts.ts:181-186` — the synth
  slot is overwritten by the next request, so a killed synth task polls the
  *survivor's* child, sees success, and resolves Ok with its own mp3 path —
  a file edge-tts was killed before writing. With DEPTH=3 prefetch, chunks
  resolve to missing files and read-aloud aborts mid-document.
- [ ] `src-tauri/src/fs.rs:369-391` — untitled-tab recovery is write-only:
  nothing lists or offers `app_data/recovery/` back on launch. The user must
  know the path from the manual. Add a launch-time scan + prompt (and then
  prune: L5).
- [ ] `src-tauri/src/fs.rs:241` vs `src/stores/tabs.ts:219` — the
  silent-clobber protection hangs on the literal error-string prefix
  `mtime-conflict`, but the tests fabricate that string on both sides
  (`tests/tabs.test.ts:177,202`), so a rename on either side kills the data-loss
  guard with the whole suite green. Pin the contract: a Rust test asserting
  the prefix + a shared constant in the TS matcher.

## Medium priority

**Data & correctness**
- [ ] `src-tauri/src/export.rs:39-52` — `export_pandoc` never calls
  `guard.check(&src)`; every other file command does. A compromised webview
  (or frontend regression) can point pandoc at any path. Also: pandoc's write
  is not atomic (no `atomic_write`, partial output on failure).
- [ ] `src/commands/registry.ts:87-92` — HTML export probes existence via
  `readFile` *before* `fsAllow`, so an existing out-of-scope destination is
  "absent" and the later `writeFile(..., null)` clobbers it unconditionally.
- [ ] `src/panels/FileTree.tsx:82-98` — renaming/moving a file open in a tab
  desyncs the tab path; the next autosave recreates the stale file through
  `atomic_write` (two divergent copies).
- [ ] `src-tauri/src/lifecycle.rs:56-62` — the 3 s watchdog deadline is fixed;
  a many-tab flush on slow storage can be killed mid-flush (distinguish
  "webview dead" from "still flushing").
- [ ] `src/stores/tabs.ts:124-138` — closing a dirty untitled tab discards it
  silently (no confirm, no recovery write) — inconsistent with the quit path.
- [ ] `src/stores/workspace.ts:24` + `src-tauri/src/fs.rs:719-725` — watcher
  failure to start is toasted-never, and runtime `Err` events from notify are
  dropped: the app can silently stop detecting external edits.
- [ ] `src/App.tsx:44-48` — "Reload from disk" fails silently (catch-{}); the
  banner is cleared before the reload resolves.

**Security / confinement**
- [ ] `src-tauri/src/fs.rs:139-145` — allowing one *file* recursively grants
  its whole parent directory (fs + asset scopes): dropping one image from
  `~/Downloads` exposes the entire tree. Grant file + `<doc>_assets` only.
- [ ] `src/commands/registry.ts:69,73` — HTML export interpolates TOC entries
  and `<title>` unescaped into the exported file (body is DOMPurify'd; these
  two are not). A heading like `<img src=x onerror=…>` executes in the
  *recipient's* browser. HTML-escape both.
- [ ] `src-tauri/src/fs.rs:127-147` — `fs_allow` is webview-callable with any
  path, making FsGuard advisory against a compromised renderer (it stops
  accidents, not attacks). Worth a comment/decision; hardening = moving the
  allow calls behind the picker commands.
- [ ] `src-tauri/src/tts.rs:211-214` — TTS temp files: predictable
  `{epoch_ms}-{pid}` names, `fs::write` (follows symlinks, not exclusive),
  0644 in shared `/tmp` — document text readable by other local users. Use
  `OpenOptions` `create_new(true)` + `0600`, or a per-process temp subdir.
- [ ] `src-tauri/tauri.conf.json:25` — `connect-src ws://localhost:* http://localhost:*`
  are dev-server allowances shipped to prod; they re-open at the CSP layer
  what the Ollama SSRF guard closes in Rust. Drop for prod builds.

**Packaging / CI**
- [ ] `scripts/fix-deb-desktop.sh:30-34` — repacks `data.tar.gz` only; the
  desktop file no longer matches `md5sums` in `control.tar.gz` → `dpkg --verify`
  fails on every installed machine. Recompute md5sums too.
- [ ] `package.json:10` — the `%f` desktop-entry fix lives only in this
  script; a plain `tauri build --bundles deb` (future release CI) ships the
  broken entry. CI never builds the deb at all.
- [ ] CI gaps: no vite-build/deb artifact step, single-OS only (platform
  branches in pick.rs/tts.rs never compile elsewhere), no clippy/fmt/coverage.
  (An earlier draft claimed `generate_handler!` signature mismatches escape
  CI — wrong: `cargo test` compiles the macro, so a mismatch fails CI.
  Corrected per blind review.)
- [ ] Test gaps on the highest-consequence code: `quitFlow()` (zero tests),
  the `handle_exit_requested` watchdog, `chat.ts` stream-callback plumbing
  (the mock never invokes the callbacks), and the editBridge
  flush-before-destructive-action ordering (a deleted `flushPendingEmit()`
  call in `close()` would pass the whole suite while losing the last 80 ms
  of typing on every close).
- [ ] `src/stores/chat.ts:23` + `src/commands/registry.ts:164` — chat-history
  persistence and editor clipboard-write failures are console-only (invisible
  in a packaged app).

## Low priority

- `src/ai/diff.ts:16` — wordDiff LCS is O(n·m) memory; a 10 k-word expand
  ≈ 400 MB and a renderer crash (documented; crash-not-slowness is the issue).
- `src-tauri/src/fs.rs:1015-1037` — workspace search follows file symlinks
  outside the allowed root into hit lines (adjacent to the documented
  symlink ceiling).
- `src/editor/imageMap.ts:23-31,101-113` — LRU-evicted image cache means
  `stripImageDataUrls` can no longer reverse, and autosave persists
  multi-MB base64 blobs into the user's markdown.
- `src/editor/MuyaEditor.tsx:287-298` — external-content sync has an async
  gap where a `flushNow` can bounce stale content over newer store state.
- `src/stores/chat.ts:83-93` — stream errors replace accumulated partial
  output with `⚠ message` (deltas already received are destroyed).
- `src/panels/WorkspaceSearch.tsx:31-55` — stale search responses can
  overwrite newer ones (last-resolved wins).
- `src-tauri/src/ai_proxy.rs:126-139` — `ai_cancel` landing between
  `cancelled.remove` and `active.insert` aborts nothing (stream runs on).
- `src-tauri/src/lib.rs:94-100` — exit-time TTS cleanup routes through
  `get_webview_window("main")`; use `app.state::<TtsState>()` directly
  (window may already be destroyed → orphaned edge-tts/mpv).
- `src-tauri/src/lib.rs:15-25` — single-instance file args arriving during
  first-launch init are silently dropped (no queueing).
- `src-tauri/src/tts.rs:294-325,363-381` — xdg-open playback isn't a child:
  audio keeps playing after quit; janitor runs only from `tts_synth`.
- `src-tauri/src/fs.rs:796-801` — `recent_push` silently resets a corrupt
  recents file instead of using `read_json_preserving_corrupt` (two policies,
  one file). Flagged in phase 2, left alone (behavior change).
- `src-tauri/src/fs.rs` clipboard/image/tts probes leak one thread on timeout
  (documented, unbounded only pathologically).
- `src-tauri/src/ai_proxy.rs:86` — Ollama allowlist includes `169.254.*`
  (cloud-metadata range on VM hosts); everything else about the validator
  is solid.
- `src-tauri/tauri.conf.json:39` — `bundle.targets: "all"` for a deb-only
  project; a bare `tauri build` will fetch linuxdeploy from the network.
- `src-tauri/tauri.conf.json:28-31` — assetProtocol enabled with empty scope
  and the CSP's `asset:` entries are dead config (rendering goes through
  data URLs); `img-src https:` permits remote-image beacons from opened docs.
- `tauri.conf.json:4` — generic identifier `app.notepad.editor` (deliberate,
  but renaming later costs a config migration).
- `package.json:15` — `@muyajs/core: "^0.2.0"` while CLAUDE.md says "pinned
  exact"; make both true with `"0.2.0"` (or fix the doc).
- `src/stores/settings.ts` — no schema version; evolution currently relies on
  per-key merges + ad-hoc regex migrations.
- `tests/settings.test.ts:32` — direct singleton assignment instead of
  `vi.mocked`; works, fragile.
- `tests/tabs.test.ts:24` — constant mtime mock can't catch a swapped-argument
  bug in `markSaved` forwarding.
- `src-tauri/src/fs.rs:1171` — 5 ms sleep + `assert_ne!` on mtimes: flaky on
  coarse-mtime filesystems (FAT/tmpfs edge).
- CI merge-blocking depends on branch protection settings (not verifiable
  from the tree).

## Explicitly out of scope / accepted risk

- **Symlinks appearing after FsGuard allowance are not re-validated**
  (`fs.rs` `canonicalize_best_effort` ponytail comment) — documented ceiling;
  re-canonicalize if the threat model changes.
- **`execCommand`/synthetic-paste inline edits** — deprecated-but-universal;
  revisit only if WebKit drops it.
- **Asset-protocol path vestigial** (Rust scope grants + `protocol-asset`
  feature for a renderer that uses data URLs) — flagged in phase 2; removal
  deferred until a Linux runtime pass confirms nothing consumes `asset://`.
- **Ephemeral UI state (find/palette flags) persisted to settings.json** —
  removal is a UX behavior change; current behavior is harmless.
- **`src/ai/tts.ts:203`** — stop-vs-failure classified by error-string match;
  token-flag refactor deferred (behavior-adjacent).
- **`window.onerror`/`unhandledrejection` toast everything** — deliberate
  diagnostic surface, not bloat.
- **Inline AI edits via execCommand, literal-substring fallback in
  workspace search, no updater** — pre-existing known ceilings in CLAUDE.md,
  unchanged by this run.
- **`ponytail:` comment prefixes** — kept deliberately (owner's call, 2026-10-18).

## Missed by pipeline, caught by blind review

The context-blind reviewer (`.pipeline/blind-review.md`, sanitized dispatch)
independently re-derived the blocker and most highs before encountering
`AUDIT.md`, and verified this audit's claims against the code. Findings below
appear in no Phase-4 dimension — genuine misses, logged as such:

- [ ] **`src-tauri/src/tts.rs:187-287` (escalates the TTS high):** the killed
  synth task's `*s = None` also makes the *survivor's* poll loop see an empty
  slot and return `"stopped"` — so with DEPTH=3 prefetch (the only mode),
  read-aloud aborts after roughly one chunk. Worse than the Ok-with-missing-
  mp3 form the Phase-4 pass caught.
- [ ] **`src-tauri/src/fs.rs:28-51` (high):** `atomic_write` fsyncs the temp
  file but never fsyncs the *directory* after `rename` — the rename itself is
  not durable across power loss on ext4. The comment claims the empty-rename
  hole is closed; it is half-closed. Two lines to fix.
- [ ] **`src/editor/muyaSetup.ts:23-26` (medium):** the image picker uses
  plugin-dialog (rfd) directly — the exact dependency `pick.rs` documents as
  hanging on some Linux setups. The one picker that skips the zenity path is
  on the machines that motivated the workaround.
- [ ] **`src/lib/tauri.ts:35-51` vs `src-tauri/src/pick.rs` (medium):** picker
  `filters` are accepted and forwarded by the TS wrapper but ignored by the
  zenity/kdialog commands — the primary path can open/save any file type.
- [ ] **`src/panels/FileTree.tsx:97-104` (medium):** delete has no
  confirmation and trashes whole directories recursively, with no check for
  open tabs (trash keeps it recoverable; a mis-click is one event away).
- [ ] **`src/App.tsx:369` (medium):** `MuyaEditor` is keyed by `tab.id`, so
  every tab switch destroys and recreates Muya — undo history does not
  survive tab switches; module-level `emitTimer`/`typeTimer` encode a
  single-editor assumption that makes this fragile.
- [ ] **`src/editor/MuyaEditor.tsx:143-183` (low):** pasted *text* that looks
  like an image path (`/tmp/photo.png`) is hijacked into a file import
  instead of pasting as text.
- [ ] **Repo hygiene (low):** `CLAUDE.md:6` says "Live at v0.2.0" while every
  manifest is at 0.3.0; empty `docs/` dir left by phase 1; `notepad:*` event
  names, `notepad-tts-` temp prefixes, keyring service name and comments
  still carry the pre-rename product name; `releases/` holds an old deb.
- **Corroborated (higher confidence):** B1, the autosave mtime poisoning, the
  recovery swallow, `export_pandoc` FsGuard bypass, single-file→parent-dir
  grant, HTML export clobber+injection, the `mtime-conflict` string contract,
  watcher silence, CSP dev allowances, stale deb md5sums — found independently
  by both passes.
- **Open question for the owner:** severity of the `fs_allow` advisory-guard
  finding. This audit rates it medium (defense-in-depth against an already
  sandboxed renderer); the blind reviewer argues high because the FsGuard
  comment oversells the guarantee it actually provides. Either way the fix
  (move allow calls behind the picker commands, or fix the comment) is the
  same; only the priority differs.

## What the audits verified clean

Secrets handling end-to-end (keychain-only, never in IPC/logs),
subprocess argv construction (11 sites, no shell), path traversal guards,
regex DoS (linear-time crate + hard caps), chat/editor sanitization under
CSP, atomic writes + conflict guard + corrupt-store preservation, SSE/NDJSON
parsing incl. hostile-input tests, freeze protection (off-thread + timeouts
on every external process), no debug residue, no panics on command paths.
