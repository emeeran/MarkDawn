# Phase 2 — Refactor Plan (dry run)

All changes are dead-code removal or renames. No behavior change anywhere.

| unit | change | why |
| --- | --- | --- |
| `src/lib/tauri.ts` + `src-tauri/src/fs.rs` + `src-tauri/src/lib.rs` | delete `pathExists` wrapper + `path_exists` command + registration | zero callers end-to-end |
| `src/ai/client.ts` | delete `StreamHandle` interface | dead type, superseded by inline `{ cancel }` |
| `src/ai/context.ts` + `tests/context.test.ts` | delete `estimateTokens` + its test | zero production callers; test only pads coverage |
| `src/ai/diff.ts` + `tests/diff.test.ts` | delete `isNoOp` + its test | zero production callers |
| `src/editor/ghostText.ts` | delete `currentGhostRect` | dead export, never imported |
| `src/editor/inserts.ts` + `src/App.tsx` | rename `PARAGRAAPH_ACTIONS` → `PARAGRAPH_ACTIONS` | typo in exported name |

Line delta: ≈ −45 lines, 0 added abstractions.

**Flagged, not touched (behavior-changing):**
- `main.tsx` global `error`/`unhandledrejection` → toast handlers: broad by design, they are the
  app's last-line error surface. Keep.
- `pick.rs` zenity→kdialog chain: would be cleaner behind a trait — deliberate ceiling, documented.
