# Blind review — 2026-10-18 (verbatim subagent output, unedited)

Dispatch context: fresh subagent, prompt framed as ordinary pre-on-call due
diligence ("review the application source as a senior engineer seeing it for
the first time"). No mention of the cleanup pipeline, its phases, or AUDIT.md.
Note: the reviewer found AUDIT.md and the phase commits in the repo itself partway
through (they are in the tree/git history) and says so below — its independent
findings were formed before that and are labeled as such by its own structure.

# MarkDawn due-diligence review

Read everything: all 9 Rust modules, all frontend source, all 10 vitest files, all inline Rust tests, configs, CI, scripts, and the repo's own `AUDIT.md`/`CLAUDE.md`. Verdict up front: **the durability and security core is real, not decorative** — but the quit path has a genuine blocker, two high-severity logic bugs survive a test suite that is honest but has a hole exactly where they live, and there's one security-boundary inconsistency. Also note: this tree has just been through an automated audit/cleanup pipeline (git log: "phase(0)…phase(4)", including a "style and authorship consistency pass"), and `AUDIT.md` (dated today) already lists most of what I found independently — I verified its headline claims against the code and they hold, with one error noted below.

## Blocker

**B1 — The quit watchdog defeats the refuse-to-exit guard, destroying the buffers it exists to protect.**
`src-tauri/src/lifecycle.rs:49-66` arms `QUIT_ARMED` *before* emitting `quit-requested`, and the only thing that disarms it is `quit_now` (`lifecycle.rs:41-44`). But `quitFlow` in `src/App.tsx:58-73` deliberately *doesn't* call `quitNow` when `flushAll()` reports failures — it toasts "Not quitting — save failed" and returns. Three seconds later the watchdog thread (`lifecycle.rs:56-62`) calls `exit(1)` and the app dies with the unsaved dirty buffers the toast just claimed were protected. Same outcome when `quitNow` itself rejects (`App.tsx:70-72` resets `quitting` but nobody disarms the Rust side). Every disk-full / read-only-fs quit hits this. Fix is small (a `disarm` command, or disarm-before-emit/re-arm-inside-quit_now), but until it lands, the app's single most important safety property is inverted.

## High

**H1 — Typing during an in-flight autosave bricks the autosave chain with a false conflict.**
`src/stores/tabs.ts:196-206`: `markSaved` skips the mtime update when `t.markdown !== markdown` (edits landed during the `await`). The tab keeps its *pre-save* mtime while disk now carries *our own write's* mtime. The next autosave (`tabs.ts:214`) fails `check_mtime` (`src-tauri/src/fs.rs:237-243`) against our own write → "mtime-conflict" → `clearTimer` halts the autosave chain (`tabs.ts:224`), banner says "This file changed on disk", and every subsequent save fails until the user manually clicks "Keep mine" or reloads. Reproducible on any keystroke during a save on slow storage. The guard comment says the fs-watcher covers the sliver; it doesn't cover this, because the divergent mtime is ours.

**H2 — TTS synth slot race makes read-aloud self-sabotaging with the DEPTH=3 prefetch.**
`src/ai/tts.ts:181-186` keeps 3 synths in flight. In `src-tauri/src/tts.rs:187-287`, `synth_inner` for request B kills the slot child (A, mid-synthesis — line 202-204) and replaces the slot. Task A's poll loop then observes *B's* child, sees success, sets the slot to `None`, and returns `Ok` with A's mp3 path — a file edge-tts was killed before writing (`tts_play` then fails `is_app_synth`'s file check). Worse, A's `*s = None` makes B's loop see the empty slot and return `"stopped"`. Net effect: with prefetching, which is the only mode, read-aloud aborts after roughly one chunk. The comment "a prefetch must not cut off live playback" describes the opposite of what the shared slot does.

**H3 — Quit proceeds when the untitled-tab recovery write fails.**
`src/stores/tabs.ts:338-345`: the last-resort `saveRecovery` for dirty untitled tabs is `catch {}`-swallowed and never pushed into `failed`, so `quitFlow` exits happily while the only copy of that text died. Inconsistent with the named-tab path two lines up, which refuses to exit on failure.

**H4 — `export_pandoc` bypasses the FsGuard.**
`src-tauri/src/export.rs:39-68` takes `src`, reads it, and writes `{stem}.{format}` with no `guard.check` — the only file-touching command that doesn't (every command in `fs.rs` does; CLAUDE.md calls this a hard invariant). It's an arbitrary-file-read/write primitive callable from the webview (read anything, output lands next to it, dest path returned to the caller). Also not atomic, unlike every other write.

**H5 — The FsGuard is advisory against the very threat model its comment claims to address.**
`fs.rs:127-147`: `fs_allow` is a webview-callable command accepting *any* path. A compromised renderer calls `fs_allow("/home/user")` and then `read_file` — the guard stops accidents, not attacks, while `fs.rs:53-56` claims "Without this, any script in the webview reads/writes the whole disk". The allow calls belong behind the picker commands (the picker returns the path; the backend allows it). At minimum the comment should stop overselling it. `AUDIT.md` flags this as medium; I'd treat the mismatch between stated threat model and mechanism as high, even if exploitation requires a renderer compromise (which is what `script-src 'self'` CSP is guarding against — so it is defense-in-depth that currently isn't).

## Medium

- **HTML export: clobber + injection.** `src/commands/registry.ts:87-89` probes existence with `readFile` *before* `fsAllow`, so an existing out-of-scope destination reads as "absent" and the later `writeFile(path, html)` (no expectedMtime, `registry.ts:91-92`) clobbers it unconditionally. Separately, `registry.ts:69-78` interpolates `<title>` (tab title) and TOC `t.content` (user headings) unescaped into the exported HTML — a heading like `<img src=x onerror=…>` executes in the *recipient's* browser. Body is DOMPurify'd; these two paths are not.
- **FileTree rename/delete desync.** `src/panels/FileTree.tsx:82-112`: renaming a file that's open in a tab leaves the tab pointing at the old path (next save conflicts or recreates the stale name — two divergent copies). Delete (`FileTree.tsx:97-104`) has no confirmation and trashes whole directories recursively with no check for open tabs. Trash makes it recoverable, but a mis-click on a directory header button is one event away.
- **Watchdog deadline vs flush duration.** `lifecycle.rs:57` fixes 3 s; `flushAll` (`tabs.ts:330-350`) does sequential fsync'd writes. Many dirty tabs on slow storage = killed mid-flush. Related to B1 — the backend can't distinguish "webview dead" from "still flushing"; there's no heartbeat.
- **Allowing one file grants its whole parent directory.** `fs.rs:139-145`: allowing a *file* recursively allows the parent dir in both the FsGuard and the asset scope. Dropping one image from `~/Downloads` exposes the entire tree (both scopes).
- **Inconsistent picker usage.** `src/editor/muyaSetup.ts:23-26` uses plugin-dialog `open()` (rfd) directly for the image picker — the exact dependency `pick.rs:5-9` documents as hanging "pre-map on some Linux setups". The one picker that skips the zenity/kdialog path is the image picker, on the machines that motivated the workaround.
- **Picker filters are dead code.** `src/lib/tauri.ts:35-51` accepts and forwards `filters`; `src-tauri/src/pick.rs` has no filters parameter — on the primary (zenity) path you can open/save anything with any extension.
- **CSP ships dev allowances to prod.** `src-tauri/tauri.conf.json:23`: `connect-src ws://localhost:* http://localhost:*` re-opens at the CSP layer what `validate_ollama_url` (`ai_proxy.rs:74-99`) carefully closes in Rust. `img-src https:` also lets opened docs beacon remote images.
- **Watcher failures are silent.** `src/stores/workspace.ts:24` swallows `watch_start` errors ("degrade to unwatched" — with no toast), and `fs.rs:719-725` drops `Err` events from notify. External-edit detection can stop working with zero signal; the conflict guard still catches writes, but "quietly adopt the newer file" (`App.tsx:253-255`) depends on the watcher.
- **`mtime-conflict` is a string-typed contract.** `fs.rs:241` emits the literal; `tabs.ts:219` matches `String(e).includes('mtime-conflict')`; `tests/tabs.test.ts` fabricates the same string on both sides. Rename the string on either side and the silent-clobber protection dies with the whole suite green. Needs a Rust test asserting the prefix + a shared constant in TS.
- **`atomic_write` durability claim is overstated.** `fs.rs:28-51` fsyncs the temp file but never fsyncs the directory after `rename`, so the rename itself isn't durable across power loss on ext4. The comment promises "a power cut could rename an EMPTY file over the target" is closed; it's half-closed. Two lines to fix.

## Low

- `app_data/recovery/` is write-only (`fs.rs:370-391`) — nothing scans or prompts for recovered untitled work on launch; the user must read the manual.
- `recent_push` (`fs.rs:796-801`) parses corrupt recents with `.unwrap_or_default()` instead of `read_json_preserving_corrupt` — two corruption policies for one file.
- `ai_cancel` race: cancel landing between `cancelled.remove` and `active.insert` (`ai_proxy.rs:126-139`) aborts nothing and leaks the map entry until natural completion. Narrow, self-healing.
- `lib.rs:94-99` routes exit-time TTS cleanup through `get_webview_window("main")` — the window may already be torn down at `RunEvent::Exit`; `app.state::<TtsState>()` is right there.
- `wordDiff` O(n·m) `Uint32Array` table (`src/ai/diff.ts:16-21`): a 10k-word "Expand" is ~400 MB and a renderer crash — and `App.tsx` toasts it via `unhandledrejection` after the crash, not before.
- imageMap LRU eviction (`src/editor/imageMap.ts:23-31`) means `stripImageDataUrls` can't reverse an evicted image and autosave persists multi-MB base64 blobs into the user's markdown. Lossless, just bulky.
- Chat stream errors replace accumulated partial output with `⚠ message` (`src/stores/chat.ts:100-110`) — received deltas destroyed on a late error.
- `MuyaEditor` is keyed by `tab.id` (`App.tsx:369`), so every tab switch destroys and recreates Muya — undo history does not survive tab switches. Module-level `emitTimer`/`typeTimer` (`MuyaEditor.tsx:22-23`) encode a single-editor assumption that the per-tab key makes fragile.
- A text paste whose content looks like an image path (`/tmp/photo.png`) is hijacked into a file import instead of pasting text (`MuyaEditor.tsx:143-165,174-183`).
- Old-name residue: `notepad:*` window events, `notepad-tts-` temp prefixes, `notepad-test-` test dirs, keyring service `app.notepad.editor.ai`, comments saying "`notepad foo.md`" (`App.tsx:107`, `lib/tauri.ts:110`) — plus the identifier `app.notepad.editor` in `tauri.conf.json:5`. Cosmetic, but it's the kind of thing that confuses the next on-call.
- Doc/version drift: `CLAUDE.md:6` says "Live at v0.2.0" while package.json/Cargo.toml/tauri.conf.json are all 0.3.0; `package.json:18` says `^0.2.0` while CLAUDE.md claims "pinned exact" — and `scripts/trim-muya.mjs` regex-scrapes muya's dist layout, so an in-range upgrade could land a layout it can't parse (the guard at the `dropped === 0` check does catch the total-mismatch case, to its credit).
- `scripts/fix-deb-desktop.sh:30-34` repacks only `data.tar.gz`; `md5sums` in `control.tar.gz` goes stale, so `dpkg --verify` fails on every installed machine. And the `%f` fix exists only in this post-build script — CI never builds the deb.
- Housekeeping: empty `docs/`, committed process scaffolding (`.pipeline/`, `trash2review/`), `local/` marketing copy, `releases/MarkDawn_0.2.0_amd64.deb` in-tree (gitignored, but present).
- Ollama allowlist includes `169.254.*` (`ai_proxy.rs:86`) — the cloud-metadata range on VM hosts. Everything else about that validator is solid and tested.
- Workspace search follows file symlinks outside the allowed root (`fs.rs:1037`) into hit lines — adjacent to the documented symlink ceiling.

## Test suite honesty

Better than average, and not theater. `tests/tabs.test.ts` pins real data-loss invariants with fake timers (tab-B-doesn't-cancel-tab-A, dirty-kept-when-edits-land-mid-save, mtime-conflict keeps the buffer, save-as clash guard, self-save echo window); the Rust `#[cfg(test)]` modules test behavior (atomic-write temp cleanup on rename failure, corrupt-store preservation, hostile SSE input, UTF-8 chunk splitting, URL allowlist, argv validation), not snapshots.

But the gaps are exactly where the high findings live: `quitFlow()` and the watchdog have zero coverage (untestable as written — module-level `quitting` flag and a Rust-side thread); the chat test mock never invokes `onDone`/`onError`, so `chat.ts`'s terminal-state plumbing is untested (the test hand-mutates state instead, `tests/chat.test.ts:31-38`); the emit-flush test registers its own callback, so deleting `flushPendingEmit()` from `close()` passes the whole suite; there is no e2e (`tsconfig.json` excludes a nonexistent `e2e/` dir); and CI (`.github/workflows/ci.yml`) runs only tsc + vitest + `cargo test` — no clippy/fmt, no vite build, no deb artifact, single OS, so the platform-branched code in `pick.rs`/`tts.rs`/`fs.rs` never compiles anywhere but Linux.

One correction to the repo's own `AUDIT.md`: it claims CI provides "no `tauri::generate_handler!` signature validation (only a real build catches a command-arg mismatch)" — wrong; `cargo test` compiles the lib including the macro, so an IPC signature mismatch fails CI. That finding is a false positive.

## Genuinely fine (one line each)

- **Secrets** (`secrets.rs`): keychain-only, whitelist of 3 providers, `read_key` is `pub(crate)` and never a command — keys verifiably never reach JS or settings.json.
- **`ai_proxy.rs`**: the best module in the tree — byte-level SSE/NDJSON buffering with hostile-input tests, abort-map with spawn/insert race handling, provider-parsed error bodies, length cap. Parsers, allowlist, and `chat_messages` all tested.
- **Atomic writes / corrupt-store preservation / mtime guard mechanism** (`fs.rs:32-51, 832-847, 237-243`): sound apart from the dir-fsync nit and the string contract; heavily tested.
- **`tts.rs` argv handling**: `--flag=value` joined form plus strict `[+-]digits` validation, `kill_on_drop`, janitor — injection-safe and tested.
- **`menu.rs`**: static, boring, ids are a clean contract with the registry. Exactly what a menu module should be.
- **`editBridge.ts`**: the single-writer discipline for the editor is real and consistently honored; the stale-range abort (`focusAndRetarget`) prevents cross-tab AI inserts.
- **Search** (`fs.rs:896-1056`): hard caps on files/depth/size/hits, linear-time regex crate, skip dirs, tested.
- **ErrorBoundary + global error toasts** (`main.tsx`, `ErrorBoundary.tsx`): small and appropriate.

## Provenance note

The code reads as heavily AI-assisted (the `ponytail:` tagged-limitation convention, doc comments that cite historical bugs, `AUDIT.md`'s "six independent audit passes"), but not in a bad way: it is one coherent voice, the self-flagged ceilings (`execCommand`, symlink re-validation, LCS diff, no updater) are accurate, and CLAUDE.md's "hard invariants" section matches what the code actually does — with the exception of the FsGuard invariant, which H4/H5 show is already violated once and structurally defeatable. The main risk for your team isn't hidden rot; it's that the pipeline's own audit has shipped as `AUDIT.md` with open checkboxes — B1, H1, H2, H3 in this review are the same findings, still unfixed in HEAD.

---

## Dispatcher note (added after the verbatim review, not part of it)

Honest limit: this reviewer ran on the same underlying model as the six
Phase-4 audit passes. The sanitized dispatch removed self-grading and framing
bias, and the reviewer did form its blocker/high findings before encountering
AUDIT.md in the tree — but it shares the model's blind spots either way. For
a genuinely independent signal, paste a sample of the finished code into a
brand-new session (or better, a different reviewer's eyes) and ask the same
cold-review question.
