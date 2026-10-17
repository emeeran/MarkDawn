# Refactor Plan — dry run 2026-10-18

Sources: two parallel scans (TS, Rust). Rule applied throughout: no behavior
change; anything behavior-adjacent is left alone and flagged for AUDIT.md.

## Unit A — Rust dedup & dead code (src-tauri)

| # | Change | Sites | Why | Conf |
| --- | --- | --- | --- | --- |
| A1 | Extract `Cmd::ok(v)` / `Cmd::err(e)` constructors on `pick::Cmd` | 8 copies of the same 4-line ok/err match: ai_proxy.rs:185,201; fs.rs:915; export.rs:30; pick.rs:75; tts.rs:98,144,160 | classic re-derivation; single definition | high |
| A2 | Extract `fn epoch_ms() -> u64` | fs.rs:327,352,785; tts.rs:204 | 4 copies of timestamp idiom | high |
| A3 | `default_ollama_url()` returns `DEFAULT_OLLAMA` const | ai_proxy.rs:43 vs 154 | one constant, two literals | high |
| A4 | Extract `fn ollama_endpoint(base, path)` | ai_proxy.rs:158, 509 | dense 1-line URL rebuild duplicated | high |
| A5 | Delete dead `ollama_models` command: Rust cmd + lib.rs registration + TS wrapper `ollamaModels` | ai_proxy.rs:181-190; lib.rs; tauri.ts:82 | live path is `list_models`' ollama arm; 0 call sites | high |
| A6 | Delete dead `WatchState.root` field + 2 assignments + stale `#[allow(dead_code)]` comment | fs.rs:21-22, 683, 728 | written, never read; comment describes wrong field | high |
| A7 | Delete `shutdown` alias; lib.rs calls `stop_internal` | tts.rs:50-52, lib.rs:99 | two names, one operation | high |
| A8 | Inline `is_within` | fs.rs:87, single caller | one-liner wrapper | medium |
| A9 | Comment dedup: menu.rs:87-94 (rationale stated twice); delete "Managed-state constructor." doc comments (ai_proxy.rs:56, fs.rs:25) | — | comment noise | high |

## Unit B — TS dedup & dead code

| # | Change | Sites | Why | Conf |
| --- | --- | --- | --- | --- |
| B1 | Delete `findSubstring`; call `indexOf` inline | ai/context.ts:43, caller :24 | 3-line wrapper adding nothing | high |
| B2 | Delete `githubCss` export | themes/raw.ts:10 | zero importers | high |
| B3 | Delete `convertFileSrc` re-export + import | lib/tauri.ts:1,155 | zero importers | high |
| B4 | App.tsx:63 uses `tauri.quitNow()` instead of raw `invoke('quit_now')` | App.tsx, tauri.ts:115 | wrapper exists and is bypassed — unify on it | high |
| B5 | Delete dead `def` field from `AiFeature` + tautological tests | ai/prompts.ts:140-171; tests/prompts.test.ts:42-47 | `def` is `true` in all 14 entries, read only by a test asserting it | high |
| B6 | Delete dead `loaded` flag + strip-destructure from settings store | stores/settings.ts:13,22,39,41,50 | written/stripped, never read (will confirm settings tests don't pin it) | high |
| B7 | Drop always-true boolean from `taInsert`; remove dead `!ok` branch in TransformPopover span path | editBridge.ts:49-56; TransformPopover.tsx:125-128 | both arms return `true`; failure toast unreachable | medium |
| B8 | Extract `pasteFromOs(docDir, msg)`; `onDropImage` reuses `importFile` | MuyaEditor.tsx:176-198, 211-221 | paste fallback block duplicated verbatim ×2; drop chain duplicated | high |
| B9 | Extract shared `openFolderViaPicker` / `openFileViaPicker` | FileTree.tsx:149, registry.ts:40-56, App.tsx:434-453 | same pick→open→toast flow ×3 (folder) + ×2 (file) | medium |
| B10 | Extract `reloadTabInto(p, tabId)` | App.tsx:248-251, 266-271 | byte-identical 5-line reload block ×2 | medium |
| B11 | Reuse `DiffRequest` type for the CustomEvent detail | App.tsx:34-40 vs 133 | same shape declared twice | medium |
| B12 | Hygiene: re-indent App.tsx:150; fix/delete stale comment App.tsx:325 (refs nonexistent `startReading setTitle`); rename `send2` → `submit`; drop `export` on inserts.ts internals; narrow ChatPanel.tsx:39 `!` after guard | — | noise, stale refs, reflexive naming | high |
| B13 | Delete padding tests: prompts.test.ts QUICK_ACTIONS-toEqual-its-own-derivation; clipboard.test.ts zero-input case | tests/prompts.test.ts:42-44; tests/clipboard.test.ts:22-24 | asserts a constant equals its own definition / entailed case | high/medium |

## Considered and left alone (flagged, not changed)

- `recent_push` bypasses `read_json_preserving_corrupt` (fs.rs:747) — real inconsistency, but fixing it changes observable behavior (corrupt file preserved+renamed). → AUDIT.md.
- Asset-protocol path possibly vestigial (fs.rs:143,687; protocol-asset feature; tauri.ts re-export removed in B3) — deletion needs a Linux runtime check that nothing consumes `asset://`. → AUDIT.md.
- Ephemeral UI state (find/palette flags) persisted to settings.json — removal is a UX behavior change. → AUDIT.md.
- `tts.ts:203` classifies stop vs failure by error-string match — token-flag refactor is behavior-adjacent. → AUDIT.md.
- `off_thread` bridge ×6, clipboard tool-loop ×3, TTS child-poll ×2, anthropic/bearer model-list merge — extractions possible but each site is small and semantics differ subtly; consolidating adds indirection for little line savings ("boring over clever"). Left alone.
- `featureEnabled` checked at 3 layers — defensible layering (menu path needs the dispatch-time check).
- `ponytail:` comment prefixes (5 files) — unknown provenance; content is useful. **Need your call: keep the greppable prefix or strip it?** Default: keep.
- `main.tsx` global error toasts — deliberate diagnostics, not bloat.

## Net effect estimate

≈ 120–160 lines removed net, zero behavior change. Tests re-run per unit;
commits: `phase(2): debloat and refactor — rust dedup`, `— ts dedup`,
`— hygiene and tests` (or one commit if units land together cleanly).
