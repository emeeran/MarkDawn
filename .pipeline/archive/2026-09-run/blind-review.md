# Blind Review — 2026-09-14 (verbatim, unedited)

Reviewer context: fresh session, sanitized dispatch (cold due-diligence review request; no
information about the cleanup pipeline, the audit, or any prior work). The reviewer found and
cross-checked the repo's own AUDIT.md on its own initiative.

---

Review complete. I read the full source (8 Rust modules, all frontend stores/panels/editor/ai modules), ran `tsc --noEmit` (clean), `vitest run` (13 pass), and `cargo test` (5 pass), and cross-checked against the repo's own `AUDIT.md`.

## Context you need first

The repo contains its own `AUDIT.md` (dated today, committed as "phase(4): production readiness audit") plus `.pipeline/` and `trash2review/` — artifacts of an automated cleanup pass that ran on this tree. I verified its major claims against source independently; they all reproduce. Findings below are mine, with the ones **AUDIT.md misses** called out.

## P0 — data loss / ship blockers

1. `/home/em/code/wip/Notepad/src/stores/tabs.ts:22,87-88` — **one module-level autosave timer shared by every tab**; typing in tab B within 500 ms cancels tab A's pending write, and A stays unsaved until re-edited. Missed by AUDIT.md; it compounds every debounce issue below.
2. `/home/em/code/wip/Notepad/src-tauri/src/lib.rs:12-73` — no `on_window_event`/`RunEvent` handler anywhere (grep confirms), so debounced saves (80 ms Muya + 500 ms tabs) are never flushed on quit.
3. `/home/em/code/wip/Notepad/src/stores/tabs.ts:59-72,122` — `close()` proceeds after a failed save (toast only) and after a **cancelled** Save-As (`path` null → early return, tab still removed): untitled doc gone, no prompt.
4. `/home/em/code/wip/Notepad/src/stores/tabs.ts:98,112-129` — `saveById` on an untitled *background* tab routes to `saveActiveAs`, which writes the **active** tab's content and assigns the path to the active tab.
5. `/home/em/code/wip/Notepad/src/stores/tabs.ts:101` — `markSaved(id, tab.markdown)` after `await` clears the dirty flag with pre-write content; edits made during the write are marked saved.
6. `/home/em/code/wip/Notepad/src/App.tsx:140-148` — external-change detection only covers the **active** tab; background tabs stay silently stale and their next autosave clobbers the newer file on disk. Missed by AUDIT.md.
7. `/home/em/code/wip/Notepad/src-tauri/tauri.conf.json:23,26` + `/home/em/code/wip/Notepad/src-tauri/src/fs.rs:47-97,236-238` — `csp: null`, `assetProtocol.scope: ["**"]`, and every fs command accepts raw webview paths with `../` traversal: the webview is one sanitizer escape from arbitrary file write.
8. `/home/em/code/wip/Notepad/src-tauri/src/ai_proxy.rs:71-81` — abort handle inserted *after* spawn and never removed on natural completion: immediate cancels miss, and the map grows by one leaked handle per completion.

## P1 — correctness bugs

9. `/home/em/code/wip/Notepad/src-tauri/src/ai_proxy.rs:310,361,399` — `from_utf8_lossy` per network chunk turns multi-byte chars split across chunk boundaries into U+FFFD; CJK/emoji completions mojibake. Fix is small: keep a byte buffer, decode whole lines.
10. `/home/em/code/wip/Notepad/src/panels/TransformPopover.tsx:90` + `ai_proxy.rs:71-76` — Stop aborts the Rust task, which never sends `Done`, so the card hangs on "Working…" and Apply never appears. `chat.ts:76-88` handles the identical case locally — two consumers of one API disagree.
11. `/home/em/code/wip/Notepad/src/panels/TransformPopover.tsx:61` + `/home/em/code/wip/Notepad/src/editor/editBridge.ts:62-64` — `original` is captured at mount but `replaceSelection` writes at the *current* caret; click elsewhere mid-stream and Apply lands the rewrite in the wrong place.
12. `/home/em/code/wip/Notepad/src-tauri/src/ai_proxy.rs:73-75` + `/home/em/code/wip/Notepad/src/stores/chat.ts:54-62` — Rust sends Error then Done, so `onDone` persists the "⚠ …" error text as a real assistant message.
13. `/home/em/code/wip/Notepad/src/stores/workspace.ts:23` — watcher failure swallowed with no user signal; external-change protection silently off (inotify limits make this realistic).
14. `/home/em/code/wip/Notepad/src-tauri/src/lib.rs:18` — file args are only handled in the second-instance callback; cold start `notepad foo.md` silently ignores the file.

## P2 — security / operational

15. `/home/em/code/wip/Notepad/src-tauri/src/ai_proxy.rs:96-99,145-146,380` — frontend-supplied `ollama_url` used as a fetch base with no host/scheme allowlist.
16. `/home/em/code/wip/Notepad/src-tauri/src/tts.rs:125-128,133-188` — document text in a predictable 0644 `/tmp` file, never deleted; synth/player children have no `kill_on_drop` and no shutdown kill.
17. `/home/em/code/wip/Notepad/src-tauri/src/ai_proxy.rs:166-185` — anthropic `list_models` ignores HTTP status (401/5xx → empty list) while the openai/groq path in the same file checks it — inconsistent within one module.
18. `/home/em/code/wip/Notepad/src/panels/FileTree.tsx:21-35,77-89` — no filename validation on create/rename; `../` escapes the workspace, rename silently replaces an existing file. Delete has no confirm either (trash, but see finding 6: a deleted-and-recreated file resurrects from a still-open tab).
19. `/home/em/code/wip/Notepad/src/panels/SettingsDialog.tsx:26-37` — `saveKey`/`removeKey` have no catch; locked keychain = unhandled rejection, and errors surface via blocking `alert()` while the rest of the app uses the toast store.
20. No CI, no logging/tracing, release builds discard stderr (`main.rs:1`), no updater path.

## P3 — consistency, AI-slop, cruft

21. `/home/em/code/wip/Notepad/src-tauri/src/tts.rs:110-119` — **verbatim duplicated block** (trim → cap 30k → `stop_internal`, twice, with mismatched `state`/`&state`); a botched refactor that still compiles. Clearest AI/refactor artifact in the repo.
22. `/home/em/code/wip/Notepad/src-tauri/src/ai_proxy.rs:266-268` — a Groq-specific model recommendation hardcoded into the generic `post_stream` error path, so it fires for every provider.
23. Same rule implemented twice across languages with different term lists: `ai_proxy.rs:219-224` (`is_chat_model`) vs `/home/em/code/wip/Notepad/src/stores/settings.ts:22-24`. Also the Ollama default URL duplicated (`types.ts:80` / `ai_proxy.rs:43-45`).
24. `/home/em/code/wip/Notepad/src-tauri/src/ai_proxy.rs:96-124` vs `144-162` — the Ollama model-listing body is copy-pasted between the command and `list_models`.
25. Pointless dynamic imports of statically imported modules: `/home/em/code/wip/Notepad/src/panels/ChatPanel.tsx:31`, `/home/em/code/wip/Notepad/src/commands/registry.ts:128,131-134`, `/home/em/code/wip/Notepad/src/panels/CommandPalette.tsx:84`.
26. `/home/em/code/wip/Notepad/src/panels/CommandPalette.tsx:83` — `async function useWorkspaceOpen` named like a React hook; and ⌘P only sees already-expanded folders because it walks the lazily loaded tree.
27. `/home/em/code/wip/Notepad/src/panels/ChatPanel.tsx:75` — dead no-op `onClick={() => settings.set('aiPanelOpen', settings.aiPanelOpen)}`.
28. `/home/em/code/wip/Notepad/e2e/smoke.spec.ts` — dead test: imports `{ t }` from `@playwright/test`, drives a Tauri app with Playwright's **Electron** launcher, and `void expect`/`void electron` exist purely to defeat `noUnusedLocals`; excluded from tsconfig so it never even typechecks. Pure false confidence.
29. README drift: claims 15 tests (suite is 13 — the cleanup phase deleted 2 tests of functions it also deleted, and left the README); claims "regex / case / whole word" find (`README.md:29`) while `FindBar.tsx:21` hardcodes case-insensitive and exposes no whole-word control; omits the Groq provider that `types.ts:16` supports.
30. Repo hygiene: `.pipeline/`, `trash2review/`, `AUDIT.md`, `PLAN.md` (15 KB) are committed build/process scaffolding, not product.
31. Minor: `recent_push`/`recent_clear` use plain `fs::write` while everything else uses the module's own `atomic_write` (`fs.rs:185,192` vs `224`); `.contains(".tmp")` watcher filter drops legit `.tmp`-containing paths (`fs.rs:134`); menu exposes 4 pandoc formats while `export.rs:30` accepts 7; version duplicated across `package.json`/`tauri.conf.json`/`Cargo.toml`.

## Testing

18 tests, all passing, all covering pure functions (`wordDiff`, `buildContext`, `buildTransformPrompt`, `extract_api_error`, `is_chat_model`, `atomic_write`). Zero coverage on: the tabs store (the entire dirty/autosave/close surface — the app's one job), the chat streaming state machine, the hand-rolled SSE/NDJSON parsers (where the UTF-8 bug lives), fs commands, and the watcher. `vitest.config.ts` is node-only, so React/store layers are 0% by construction. No CI exists to run even what does exist.

## Verdict

**Not on-call-ready as a distributed product; tolerable only as a single-user tool, and even then grudgingly.** The architecture is sound and unusually well-documented (keychain-only secrets, argv-array subprocesses, atomic writes, DOMPurify sink — all verified real), but the code is built in a layer that has never been executed under failure: every bug above is in the "what happens when the operation fails" branch.

Demand fixed first, in order: **(1)** per-tab save timers + flush-on-quit + refuse-to-close-on-failed-save (findings 1-5, one store rewrite); **(2)** external-change handling for background tabs (6); **(3)** CSP + scoped asset protocol + workspace-confined fs commands (7); **(4)** a CI job running `tsc --noEmit && vitest run && cargo test`, plus real tests on the tabs store and the SSE parsers. Until 1 and 4 land, nobody should carry a pager for this — a user losing an hour of writing is the most likely incident, not a security one.

---

## Honest limit

This reviewer ran on the same underlying model as the audit passes. The sanitized dispatch removes
self-grading and framing bias — both real — but not blind spots the model itself has. For a
genuinely independent signal, paste a sample of the finished code into a brand-new session
(fresh terminal, fresh conversation, ideally a different reviewer) and ask the same cold-review
question.
