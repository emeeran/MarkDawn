# Purge Plan — dry run 2026-10-18

Baseline: 136 tracked files. No exact/near-duplicates found (md5 sweep).
No committed build artifacts (`.gitignore` already covers `dist/`, `target/`,
`node_modules/`, `src-tauri/gen/`).

## Proposed moves (git mv → trash2review/)

| path | reason | confidence | inbound refs |
| --- | --- | --- | --- |
| `docs/markdawn-architecture.visual-check.*.png` (4 files) | Generated screenshot artifacts of a diagram; binary outputs should not live in git | high | none |
| `docs/markdawn-architecture.visual-check.html` / `.json` | Same generation run; checker output, not a doc | high | none |
| `docs/read-aloud-pipeline.visual-check.*.png` (4 files) | Same as above | high | none |
| `docs/read-aloud-pipeline.visual-check.html` / `.json` | Same as above | high | none |
| `docs/markdawn-architecture.html` / `.architecture.json` | Zero inbound references anywhere; renders a diagram whose content duplicates CLAUDE.md's architecture section | medium | none |
| `docs/read-aloud-pipeline.html` / `.sequence.json` | Zero inbound references; TTS pipeline diagram (nice-to-have doc) | medium | none |
| `PLAN.md` | CLAUDE.md itself declares it historical ("original build plan", not current state); last substantive commit 2026-09-18 | medium | CLAUDE.md (descriptive mention — will be updated) |

## Kept after review

| path | why kept |
| --- | --- |
| `media/icon-source.png` | Zero refs, but it is the design source for `src-tauri/icons/*` — deleting loses the only non-exported master asset |
| `media/MarkDawn-Logo.png` | Product logo; referenced by docs/branding uses |
| `requirements.txt` | Referenced from README.md and USER_MANUAL.md |
| `scripts/trim-muya.mjs`, `scripts/fix-deb-desktop.sh` | Referenced from package.json and muyaSetup.ts |
| `AUDIT.md` | Historical but still the audit record; Phase 4 of this run rewrites it |

## Effect if applied

- 17 files out of the tree (16 diagram artifacts + PLAN.md), ~2.4 MB of
  screenshots removed from the working tree, nothing hard-deleted.
- `CLAUDE.md` line 8–9 updated: PLAN.md noted as moved to trash2review.
- README.md / USER_MANUAL.md checked for `docs/` links (none found so far).
