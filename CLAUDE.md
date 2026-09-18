# CLAUDE.md — MarkDawn

Typora-style Markdown editor: Tauri 2 (Rust) + React 19 + TypeScript, editor
engine `@muyajs/core` 0.2.0 (**pinned exact** — pre-1.0 API churn; upgrade
deliberately). Product name **MarkDawn**, binary `markdawn`, identifier
`app.notepad.editor`. Live at v0.2.0.

Historical planning docs, not current state: `PLAN.md` (original build plan),
`AUDIT.md` (2026-09-14 audit; most blockers were fixed after it — CSP, asset
scope, FsGuard, flush-on-quit, CI, tabs-store tests). `.pipeline/` and
`trash2review/` are process scaffolding; nothing in `trash2review/` is built or
tested.

## Commands

```sh
npm run dev          # vite only (rarely useful alone)
npm run tauri dev    # full dev app, hot reload
npm run build        # tsc --noEmit && vite build
npm run typecheck    # tsc --noEmit
npm test             # vitest run (node env, no DOM)
npm run deb          # tauri build --bundles deb + patch desktop entry (%f)
cd src-tauri && cargo test
```

CI (`.github/workflows/ci.yml`) runs typecheck + vitest + cargo test on
push/PR. Tests live in `tests/*.test.ts` (tabs, chat, context, diff, prompts,
settings) and inline `#[cfg(test)]` in the Rust modules (22 tests: fs guard,
atomic writes, path_join, stream parsers, URL allowlist, TTS argv validation).

## Architecture

**Data flow:** Muya `json-change` → `getMarkdown()` → zustand tabs store →
debounced `write_file` (Rust, atomic temp+rename). All AI output returns
through the edit-bridge — **never** call `setContent` / mutate Muya from
feature code; `src/editor/editBridge.ts` is the single owner of editor writes
(synthetic paste for multi-block, `execCommand('insertText')` for inline).
AI HTTP never runs in the webview — everything goes through the Rust proxy.

```
src/
  editor/    MuyaEditor.tsx (wrapper), editBridge.ts (sole write path),
             muyaSetup.ts (plugins/image tools), ghostText.ts, inserts.ts,
             imageMap.ts (path→data-URL render map)
  ai/        client.ts (streaming channel), context.ts (doc budget),
             prompts.ts (system prompt + quick actions), diff.ts (word LCS),
             transform.ts, selection.ts, tts.ts
  panels/    FileTree, Outline, TabsBar, ChatPanel, FindBar, WorkspaceSearch,
             CommandPalette, TransformPopover, SettingsDialog, WordCount
  commands/  registry.ts — every action registers here; palette AND native
             menu dispatch through it (add features here, not in components)
  stores/    zustand: settings, tabs, workspace, chat, toast — nothing else
  themes/    github/night/newsprint/pixyll.css + raw.ts (inlined into HTML export)
src-tauri/src/
  fs.rs       FsGuard: all fs commands confined to consented roots (workspace,
              picked/dropped/launch paths, app dirs); atomic_write; watcher
              (300 ms debounce, filters own .tmp); workspace_search; image
              import (<stem>_assets/); recovery saves; recent/store JSON
  secrets.rs  keychain set/delete/status only — read_key is pub(crate), never
              a command; keys never reach JS
  ai_proxy.rs streaming SSE/NDJSON proxy: anthropic | openai | groq | ollama;
              Ollama URL restricted to loopback/private (SSRF guard); 16k-char
              completion cap; abort-map with spawn/insert race guard
  tts.rs      edge-tts synth + player chain mpv→ffplay→xdg-open, kill_on_drop,
              /tmp janitor, argv-injection validation
  menu.rs     native menu; every item emits one `menu-action` id — ids are the
              contract with commands/registry.ts
  pick.rs     zenity → kdialog → dialog-plugin fallback (rfd hangs on some Linux)
  lifecycle.rs quit interception: emits quit-requested, waits for flushAll,
              3 s force-exit watchdog; startup + single-instance file args
  export.rs   pandoc, format allowlist, refuses to overwrite
```

## Hard invariants (don't break these)

- Keys: keychain only; settings.json has a boolean `isConfigured`, never a key.
- FsGuard: any new fs command must route through `guard.check`; `path_join`
  rejects separators/traversal.
- CSP: `script-src 'self'`, no inline scripts; chat output renders through
  Muya's DOMPurify-sanitized renderer.
- Ghost text default **off** (`types.ts` `ghostText: false`) — sends keystrokes
  to the provider when on; don't flip the default.
- Saves are atomic and flush-on-quit; a failed save keeps the tab. The tabs
  store has tests pinning all of this (`tests/tabs.test.ts`) — run them.

## Constants worth knowing

| Value | Meaning |
| --- | --- |
| 500 ms | autosave debounce (per-tab timers, Map not shared) |
| 10 messages | chat history sent with each request (≈5 exchanges) |
| 12 000 / 2 000 | doc context budget / window around selection (`ai/context.ts`) |
| 16 000 chars | hard AI completion cap |
| 20 MB / 30 000 chars | image display cap / TTS text cap |
| 200 hits, 4 000 files | workspace search budget (also depth 12, 512 KB/file) |
| 15 | recent-files cap |
| 3 s | quit watchdog and clipboard-fallback guard |

## Conventions

- Branches `feature/` `fix/` `chore/` `docs/`; conventional commits
  (`feat:`, `fix:`, `chore:`); no AI co-author trailers; lint + tests before
  commit. Never commit to main directly.
- Cross-language rules exist twice by necessity (`NON_CHAT_MODEL` filter in
  `ai_proxy.rs` and `stores/settings.ts`) — change both together; a vitest
  parity test guards it (`tests/settings.test.ts`).
- Linux-first reality: WebKitGTK quirks are load-bearing (images render via
  data URLs, not the asset protocol; clipboard paste has an OS fallback).
  Test on Linux before claiming a fix.

## Known issues / ceilings

- Inline AI edits use deprecated-but-universal `execCommand`/synthetic paste.
- wordDiff is O(n·m) LCS (selection-sized only); workspace search is literal
  substring; updater not wired; symlinks appearing after FsGuard allowance are
  not re-validated.
