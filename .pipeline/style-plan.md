# Style Plan — dry run 2026-10-18

## Inconsistencies found

| # | Convention | Files affected | Resolution | Why |
| --- | --- | --- | --- | --- |
| S1 | Rust formatting vs rustfmt defaults | 72 hunks across src-tauri/src (ai_proxy, fs, tts, …) — pre-existing drift, not from this pipeline | Run `cargo fmt` (no rustfmt.toml → defaults are the project standard) | One tool, zero config, repo-wide |
| S2 | JS/TS formatting | none — surveyed: no semicolons outside comments, no double-quoted code strings, no tab indentation | No change; do NOT add prettier | The style is already hand-consistent; introducing a formatter + config mid-cleanup imposes a new tool and a huge no-op diff |
| S3 | Error-handling philosophy | — | No change | Already uniform: Rust = `Result<_, String>` with `map_err(\|e\| e.to_string())`, best-effort `let _ =` only for cleanup/emit; TS = catch + toast with justification comments |
| S4 | Comment voice / emoji | — | No change | No emoji, no exclamation-heavy phrasing anywhere; comments explain why (WebKitGTK quirks, race guards), not what |
| S5 | Naming | — | No change | send2 renamed, Manager/Handler/Util suffixes absent, no type-in-name redundancy |
| S6 | Structure | — | No change | Flat modules already; no services/factories scaffolding |
| S7 | Import grouping | — | No change | All TS files: external packages → relative modules; Rust std → crate → external, consistent |
| S8 | Config knobs never varied | — | No change | Checked: every Settings field is read from real UI; ghostText default-off is a deliberate invariant |

## Apply

`cargo fmt --manifest-path src-tauri/Cargo.toml`, re-run cargo test + vitest,
commit `phase(3): style and authorship consistency pass`.

That's the entire actionable set — the audit found the codebase already reads
as one hand; the only repo-wide drift was Rust formatting.
