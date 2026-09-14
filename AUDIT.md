# Production Readiness Audit — 2026-09-14

Scope: full repo review by six independent audit passes (correctness/error-handling, security,
config/environment, observability, testing/CI, operational readiness). Findings merged and
deduplicated; severity is the highest assigned by any pass.

## Summary

**Not ready for distribution to other users; acceptable for the author's own machine today.**
The app is functional and its data-durability core is solid (atomic document writes, keychain-only
secrets, no injection surface in subprocess usage, sanitized chat rendering). The blockers are
(1) a hardening trio — no CSP, unrestricted asset-protocol scope, and unconfined fs commands —
that turns any future sanitizer escape into arbitrary filesystem access, and (2) two silent
data-loss paths (no flush-on-quit after debounced saves; closing a dirty tab proceeds even when
its save fails). Neither blocks the author's daily use; both must be fixed before shipping.

## Blockers (must fix before prod)

- [ ] `src-tauri/tauri.conf.json:23` — `csp: null` — no Content-Security-Policy; DOMPurify inside muya is the only barrier between untrusted markdown and full IPC access (flagged by security + correctness independently)
- [ ] `src-tauri/tauri.conf.json:26` — `assetProtocol.scope: ["**"]` — webview can fetch any file on disk via `asset://`; reachable from untrusted `.md` image srcs via `MuyaEditor.tsx:85-94`
- [ ] `src-tauri/src/fs.rs:47-97` — `read_file`/`write_file`/`rename`/`trash_path`/… accept raw webview paths with no workspace confinement; `path_join` allows `../` traversal (cross-confirmed by security + correctness)
- [ ] `src-tauri/src/lib.rs:12-73` + `src/stores/tabs.ts:87-88` — no graceful shutdown: debounced saves (80 ms + 500 ms) are never flushed on quit; quitting ≤580 ms after typing silently discards edits
- [ ] `src/stores/tabs.ts:59-72, 98, 100-101` — closing a dirty tab saves-then-closes even when the save failed or Save-As was cancelled (data loss); `saveById` on an untitled background tab saves the *active* tab's content to the wrong file; `markSaved` reverts in-flight edits

## High priority

- [ ] `src-tauri/src/tts.rs:133-138, 174-188` — TTS/audio child processes survive app exit (no `kill_on_drop`, no shutdown kill)
- [ ] `src-tauri/src/ai_proxy.rs:77-81` — AbortMap entries never removed on natural completion (leak); insert-after-spawn races immediate cancels
- [ ] No CI exists — nothing runs vitest/cargo tests or blocks merge; `npm test` alone skips `tsc` and all Rust tests
- [ ] `src/stores/tabs.ts` (whole store) — the data-loss surface (dirty tracking, autosave debounce, close flow) has zero tests
- [ ] `src-tauri/src/ai_proxy.rs:310, 361, 399` — `from_utf8_lossy` per network chunk corrupts multi-byte chars split across chunks (CJK/emoji completions mojibake)
- [ ] Zero logging/tracing anywhere + no React error boundary — production failures are undiagnosable after a 4 s toast; release builds also discard stderr (`main.rs:1`)

## Medium priority

- [ ] `src-tauri/src/ai_proxy.rs:98-99, 145-146, 380` — frontend-supplied `ollama_url` used as fetch base with no host/scheme allowlist (SSRF/exfil channel)
- [ ] `src-tauri/src/tts.rs:121-127` — document text written to predictable 0644 `/tmp/notepad-tts-*.txt`, symlink-following, never cleaned up
- [ ] `src-tauri/src/ai_proxy.rs:166-185` — anthropic `list_models` ignores HTTP status (401/5xx → silent empty list)
- [ ] `src/panels/FileTree.tsx:21-35, 77-89` — no filename validation; `../` escapes workspace, rename silently replaces existing files
- [ ] `src-tauri/src/export.rs:34-46` — pandoc export silently overwrites an existing destination
- [ ] `src/ai/diff.ts:16` + `TransformPopover.tsx:96` — wordDiff recomputed per streamed delta with unbounded O(n·m) allocation
- [ ] `src/panels/TransformPopover.tsx:61, 70-90` — `original` captured at mount but applied to the *current* selection; cancel leaves the card stuck on "Working…"
- [ ] `src/lib/tauri.ts:12-18` — `cmdWithChannel` has no timeout/panic handling; `tabs.close()` awaits it and can stall
- [ ] `src-tauri/src/secrets.rs:30-39` + `SettingsDialog.tsx:22-37` — blocking keyring queries on the main thread; key ops have no catch (locked keychain = silent no-op)
- [ ] `src/stores/workspace.ts:23` + `src-tauri/src/fs.rs:109-114` — watcher failures swallowed, never retried; notify errors indistinguishable from quiet dirs
- [ ] `src-tauri/src/fs.rs:176-187` — `recent_push` is a non-atomic read-modify-write (crash truncates recents)
- [ ] `src/stores/chat.ts:18-20` + `fs.rs:212-215` — chat history persist is fail-silent; corrupt file silently reset then overwritten
- [ ] `src/panels/SettingsDialog.tsx` — secret errors surface via inconsistent blocking `alert()`
- [ ] Testing environment: `vitest.config.ts` is node-only; React/store layers 0% by construction; SSE parsers hand-rolled and untested
- [ ] No auto-update path (updater plugin absent; acknowledged in README)
- [ ] `src/panels/TransformPopover.tsx` + `src/stores/chat.ts:47-52` — post-cancel deltas can land on the next stream's bubble; Error-then-Done ordering fires `onDone` with error text

## Low priority

- `pick.rs:52-58` / `tts.rs:132-134` — argv flag-injection via `-`-prefixed `default_name`/`voice`
- `capabilities/default.json:6-12` — broader than needed (`core:default`, unscooped opener perms)
- `chat-history.json` / `settings.json` persisted unencrypted (contents include document text)
- `SettingsDialog.tsx:166-171` — key input lacks `autocomplete="new-password"`
- `tts.rs:105-119` — duplicated trim/cap/stop block (refactor leftover; benign at runtime)
- `fs.rs:134` — `.tmp` substring filter drops legitimate `*.tmpl` paths
- `fs.rs:169-172, 207-215` — corrupt config JSON silently reset to empty
- `ghostText.ts:24-29` — `attachGhostText` not idempotent (listener leak on attach-without-detach)
- `ghostText.ts:98-110` — Tab capture is document-wide; Tab in chat textarea inserts ghost text into the editor
- `editBridge.ts:55-58` — 50 ms sleep decides paste-vs-fallback on large docs
- `e2e/smoke.spec.ts` — dead test importing uninstalled playwright packages (false confidence)
- `README.md:79` — test count drifted (says 15, suite is 13)
- `Cargo.toml:6` — `rust-version = "1.77"` below the resolved 1.77.2 MSRV of tauri 2.11.5
- App version duplicated in 3 files with no bump automation
- `ai_proxy.rs:44` + `types.ts:80` — Ollama default URL duplicated across languages

## Explicitly out of scope / accepted risk

- Bundling pandoc/edge-tts: detect-and-use is a deliberate v1 decision (README "Known ceilings")
- No auto-updater until a release server and signing keys exist
- Ghost text default-off; sends keystrokes to the configured provider only when enabled
- `wordDiff` O(n·m) LCS — acceptable for selection-sized inputs; documented ceiling
- `execCommand('insertText')` + synthetic paste for editor writes — deprecated-but-universal; revisit if WebKit drops them
- zenity/kdialog as primary pickers — deliberate replacement for broken-on-this-box rfd; plugin-dialog remains the cross-platform fallback
- Upstream `@muyajs/core` API churn risk — pinned at 0.2.0 by choice

## Positives (verified by the audit passes)

- Secrets: keychain-only, `read_key` is `pub(crate)` (never a command), provider allowlist, frontend never sees keys; all provider HTTP in Rust
- No command injection: every subprocess uses argv arrays, no shell; pandoc format allowlisted
- No hardcoded secrets; `dangerouslySetInnerHTML` sink is DOMPurify-sanitized by default (verified in the shipped bundle)
- `atomic_write` (temp + rename) for documents/settings with tests covering contents and temp-litter
- MuyaEditor teardown, watcher collector exit, and chat cancel state reset are all correct

## Missed by pipeline, caught by blind review

A sanitized cold-review pass (see `.pipeline/blind-review.md`) independently verified AUDIT.md's
claims — all reproduce — and found the following genuine misses. Logged here as pipeline misses,
not quietly patched:

- **`src/stores/tabs.ts:22, 87-88` — one module-level autosave timer shared by every tab.** Typing in tab B within 500 ms cancels tab A's pending write; A stays unsaved until re-edited. Compounds every debounce/data-loss issue above. (High)
- **`src/App.tsx:140-148` — external-change detection covers only the active tab.** Background tabs stay silently stale; their next autosave clobbers the newer file on disk. (High)
- **`src-tauri/src/lib.rs:18` — cold-start file args ignored.** `notepad foo.md` works only as a second-instance event; first launch drops the argument. (Medium)
- **`src-tauri/src/ai_proxy.rs:266-268` — a Groq-specific model recommendation hardcoded in the generic `post_stream` error path**, so it fires for every provider. (Medium)
- **Cross-language rule drift**: `is_chat_model` (`ai_proxy.rs:219-224`) vs the migration regex (`settings.ts:22-24`) implement the same filter with different term lists; Ollama default URL also duplicated (`types.ts:80` / `ai_proxy.rs:43-45`). (Medium)
- **`ai_proxy.rs:96-124` vs `144-162`** — Ollama model-listing body copy-pasted between command and helper. (Low)
- **Pointless dynamic imports of statically imported modules** (`ChatPanel.tsx:31`, `registry.ts:128,131-134`, `CommandPalette.tsx:84`); `useWorkspaceOpen` (`CommandPalette.tsx:83`) named like a React hook; dead no-op `onClick` (`ChatPanel.tsx:75`). (Low)
- **`e2e/smoke.spec.ts` is worse than dead** — it imports `{ t }` from `@playwright/test` and drives a Tauri app via Playwright's *Electron* launcher; pure false confidence. (Low, but upgrade the AUDIT wording)
- **README drift is bigger than the test count**: also overclaims find features (case / whole-word not exposed by `FindBar.tsx:21`) and omits the Groq provider. (Low)
- **Repo hygiene**: `.pipeline/`, `trash2review/`, `AUDIT.md`, `PLAN.md` are committed process scaffolding, not product. (Low)

**Cross-confirmed (audit + blind review agree — higher confidence):** the tabs.close()/data-loss
trio, no-flush-on-quit, `markSaved` race, the CSP/asset/fs-confinement trio, abort-map leak,
per-chunk UTF-8 lossy decode, `ollama_url` SSRF, TTS temp files + surviving children, anthropic
list_models status, FileTree filename validation, tts.rs duplicated block, dead e2e, no CI,
key-ops without catch.

**Open questions for the human (not silently resolved):**
- Keep `PLAN.md` and the pipeline scaffolding (`.pipeline/`, `trash2review/`, `AUDIT.md`) in the
  repo, or move to `trash2review` before any distribution build? Blind review flags them as
  shipped-with-product; they were kept deliberately as project history.
- e2e/smoke.spec.ts: finish it properly (tauri-driver + WebDriver) or move it to `trash2review`
  until someone commits to running it?
