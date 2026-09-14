# Notepad — a Typora replacement with AI integration

Comprehensive build plan. Target: a fast, minimal, Typora-parity Markdown editor
(WYSIWYG, no split pane) for macOS/Windows/Linux, with AI writing features built in.

---

## 1. Strategy

**Do not rebuild the editor engine.** Typora's hard part is the live-rendering
contenteditable Markdown engine — years of edge cases (IME, tables, cursor math,
round-tripping). That engine exists as an MIT-licensed library:

> **Muya** (`@muyajs/core`) — the engine extracted from MarkText, the open-source
> Typora clone. TypeScript-first, published to npm, actively developed (now inside
> the marktext/marktext monorepo). Covers CommonMark 0.31 + GFM, inline math/KaTeX,
> Mermaid, Vega-Lite, PlantUML, Prism, footnotes, front matter, reference links,
> search/replace, OT-based undo/redo, i18n, DOMPurify-sanitized rendering.

MarkText-the-app is semi-dormant — we consume only the npm engine artifact, which
decouples us from the app's maintenance troubles.

**Stack (decided):** Tauri 2 (Rust) + React + TypeScript, with `@muyajs/core`
as the editor core, and a provider-agnostic AI layer (Anthropic / OpenAI / Ollama).

**What we build ourselves:** app shell, file tree, tabs, themes, settings,
export pipeline, and the entire AI layer. Everything Typora put *around* the editor.

---

## 2. Architecture

```
┌────────────────────────── Tauri 2 window ──────────────────────────┐
│  React + TS (webview)                                              │
│  ┌────────────┐ ┌───────────────────────┐ ┌─────────────────────┐  │
│  │ Sidebar     │ │ Editor pane           │ │ AI panel            │  │
│  │ • file tree │ │ @muyajs/core          │ │ • chat w/ doc ctx   │  │
│  │ • outline   │ │ json-change event ────┼─► • inline transform  │  │
│  └────────────┘ │ selection-change ─────┼─► • ghost text        │  │
│                 └───────────────────────┘ └─────────────────────┘  │
│  Command palette (⌘K) · Settings · Theme engine (CSS vars)         │
└──────────────┬──────────────────────────────────────────────────────┘
               │ Tauri IPC (invoke + Channel for streaming)
┌──────────────▼────────────── Rust core ────────────────────────────┐
│ • workspace fs (open/save/rename/watch)   • file watcher (notify)  │
│ • OS keychain (API keys via keyring)      • ai_stream (reqwest+SSE)│
│ • pandoc export (tauri-plugin-shell)      • window/updater plugins │
└─────────────────────────────────────────────────────────────────────┘
```

**Data flow (the one that matters):** Muya emits `json-change` → debounced
serialize via `getMarkdown()` → Rust `save_file` (atomic write: temp + rename).
`selection-change` feeds the AI context extractor. AI output flows back through a
single edit-bridge module that owns all writes into Muya (never `setContent` from
feature code directly — see Risk 2).

### Repo layout

```
notepad/
├── src/                        # frontend
│   ├── editor/                 # Muya wrapper component, edit-bridge, ghost-text overlay
│   ├── ai/                     # provider config, prompt templates, context builder
│   ├── panels/                 # FileTree, Outline, ChatPanel, InlineDiffPopover
│   ├── commands/               # command palette registry (all actions registered here)
│   ├── stores/                 # workspace/tabs/settings state (zustand)
│   └── themes/                 # theme CSS files (GitHub, Night, Newsprint, Pixyll)
├── src-tauri/
│   └── src/
│       ├── fs.rs               # open/save/rename/watch, atomic writes
│       ├── secrets.rs          # keyring CRUD, never plaintext on disk
│       ├── ai_proxy.rs         # streaming SSE proxy: anthropic | openai | ollama
│       └── export.rs           # pandoc invocation
└── PLAN.md
```

---

## 3. Phases

Each phase has an exit gate. Do not start the next phase before the gate passes.

### Phase 0 — Spike week (gates the whole plan) · ~1 wk

Purpose: validate the two riskiest assumptions before any shell code exists.

1. Scaffold Tauri 2 + React + TS + Vite. Pin `@muyajs/core` to an exact version.
2. Embed Muya in a bare React component with all UI plugins registered
   (copy the canonical registration list from muya `examples/src/main.ts`).
3. Wire `json-change` → `getMarkdown()` → Rust `save_file` → reopen on launch.
4. **Spike 1 — granular edit API (go/no-go):** can we replace one block/range in
   Muya without `setContent()` on the whole doc, preserving undo history and
   cursor? Inspect the state/block API. Outcomes:
   - Found an API → use it in the edit-bridge.
   - Not public → add a small method and vendor the package (`pnpm patch` or a
     vendored copy — MIT permits). Budget: ≤ 2 days. If it exceeds that, fall
     back to full-document replace + cursor restore for v1.
5. **Spike 2 — streaming:** Rust `ai_proxy` command streaming SSE tokens into the
   webview via `tauri::ipc::Channel`, key read from OS keychain. One provider
   (Anthropic) is enough to prove the pipe.

**Exit gate:** typed paragraph in a Tauri window, saved to disk, an AI completion
streams into a `<pre>` from Rust, and we know the edit path for AI inserts.

### Phase 1 — Editor core · ~2–3 wk

- **Edit-bridge module** (single owner of all Muya mutations, built on the Phase 0
  finding): `insertAtCursor`, `replaceSelection`, `replaceBlock`, each preserving
  undo history where the API allows.
- Document lifecycle: open file (dialog + drag-onto-window + `argv` open-with),
  tabs (dirty indicators, ⌘W, ⌘⇧T reopen), atomic autosave (debounce 500 ms +
  save-on-blur/close), untitled buffer flow.
- External change handling: `notify` watcher → "file changed on disk — Reload /
  Keep mine" banner (avoid MarkText issue #656).
- Recent files, workspace folder open, window state persistence
  (`tauri-plugin-window-state`), single-instance plugin.
- Image paste/drop: Muya `ImageEditTool` `imageAction` → copy file into
  `<doc>_assets/` via Rust → rewrite relative path. `imagePathPicker` for explicit
  inserts.
- Crash safety: write-on-change is the recovery story; plus a single `.bak` on
  unsafe paths.

**Exit gate:** daily-drivable as a plain editor: open/edit/save/rename files from
a real folder, tabs, autosave, external-change prompt, image paste. No AI, no themes.

### Phase 2 — Typora-parity chrome · ~3–4 wk

- **File tree sidebar**: lazy-read dirs, create/rename/delete (Rust side, trash
  via `trash` crate), click-to-tab, sync-with-editor toggle.
- **Outline panel**: `getTOC()` → click-to-scroll; active-heading tracking.
- **Search & replace panel**: Muya's built-in `search/find/replace` (regex,
  case, whole-word) in a floating bar; plus workspace-wide grep (Rust, ripgrep
  crate) listing files → jump.
- **Theme engine**: CSS custom properties layered over Muya's `style.css`.
  Ship 4 themes ported from Typora's famous set (GitHub light, Night dark,
  Newsprint, Pixyll). A theme = one CSS file in a user-themes folder, hot-swapped,
  auto light/dark follows OS. Editor font + size in settings.
- **Writing modes**: focus mode (dim non-active lines via CSS), typewriter mode
  (scroll active line to center), source toggle (raw markdown view).
- **Command palette (⌘K)**: registry every feature plugs into — this is the
  spine AI actions attach to in Phase 4.
- Settings UI (React), persisted JSON in app-config dir: appearance, editor
  behavior, keymap overrides (preventDefault on Muya keys we remap).

**Exit gate:** side-by-side with Typora, a user can do a normal writing session
without reaching for Typora. Screenshot diff of themes against Typora originals.

### Phase 3 — AI foundation · ~1–2 wk

- **Keys:** stored only in OS keychain via `keyring` crate. Frontend receives a
  boolean `provider.isConfigured`, never the key. (Security rule: no keys in
  config JSON, no `.env`, nothing hardcoded.)
- **`ai_proxy` (Rust):** one command,
  `ai_stream(provider, model, messages, max_tokens, channel)`, a three-arm enum:
  - `anthropic` → Messages API, SSE, `anthropic-version` header
  - `openai` → Chat Completions, SSE
  - `ollama` → `localhost:11434/api/chat`, auto-detect + model list via `/api/tags`,
    zero-config when installed
  Streams deltas over the Tauri Channel; cancel by dropping the frontend
  subscription (abort handle on Rust side).
- **Frontend `ai/` layer:** provider/model picker, streaming subscription helper,
  one `systemPrompt` + context-builder that assembles:
  `{ selection?, outline (getTOC), full doc | doc tail+head, chat history }`
  with a token budget (truncate long docs to head+tail around the selection).
- Per-request timeout + error surfaces (no silent failures).

**Exit gate:** chat panel streams from all three providers; killing the app
mid-stream leaves nothing half-written; keys survive restart and never appear in
logs or config files.

### Phase 4 — AI features · ~3–4 wk

Ordered by value; each is independently shippable.

1. **Chat sidebar with document context** — multi-turn, streaming, markdown-rendered
   replies (reuse `MarkdownToHtml` + DOMPurify). Actions on replies:
   *Insert at cursor*, *Replace selection*, *Copy*. Context chip shows what the
   model sees (selection / whole doc).
2. **Select-to-transform (the killer feature)** — select text → floating action
   bar (or ⌘K): *Improve writing, Fix grammar, Translate…, Summarize, Make
   shorter/longer, Custom prompt…*. Result appears in a **diff popover**
   (old vs new, word-diff) → Apply / Retry / Cancel. Apply goes through the
   edit-bridge (undo-able).
3. **Ghost-text autocomplete** — idle 600 ms at end of a paragraph → grey
   completion overlay positioned from `selection-change` coords → Tab accept,
   Esc dismiss, any keystroke discards. Default **off** (privacy + distraction),
   model must be a fast one; never triggers on selection.
4. **AI command-palette actions** — *Continue writing*, *Generate from prompt at
   cursor*, *Summarize document to outline*, *Extract action items*.
5. **Custom instructions** — per-workspace `NOTEPAD.md` (style guide, persona)
   auto-included in system prompt.

**Exit gate:** select-a-paragraph → Improve writing → diff → Apply → ⌘Z restores
it. Ghost text only appears when enabled and only where specified.

### Phase 5 — Export, packaging, release · ~2–3 wk

- **HTML export**: `MarkdownToHtml` + theme CSS inlined, single file.
- **PDF export**: print pipeline — dedicated hidden window, theme applied,
  print CSS (page margins, `@page`), `webview.print()`. Typora does the same;
  matches its fidelity.
- **DOCX / LaTeX / RTF / OPML**: shell out to **pandoc** (`tauri-plugin-shell`);
  detect at first use, link install instructions if missing. Do not bundle pandoc
  (~100 MB) — detect-and-instruct is fine for v1.
- Packaging: Tauri bundler → dmg/msi/AppImage/deb; signing + notarization
  (macOS), auto-update via `tauri-plugin-updater`.
- Smoke e2e (Playwright + tauri-driver): open → edit → save → AI transform →
  apply. One test, run in CI; everything else stays unit-level.

**Exit gate:** v0.1.0 tagged, signed installers on all three OSes, update channel live.

---

## 4. Key decisions & rationale

| Decision | Rationale |
| --- | --- |
| Muya engine, not MarkText app | The engine is the hard part and ships as a clean TS package; the MarkText app shell is Electron/Vue and semi-dormant. We take the MIT engine and build the shell we want. |
| Pin `@muyajs/core` exact version | Pre-1.0, "APIs may change between minor versions" (their README). Pin now; upgrade deliberately. |
| AI HTTP in Rust, not the webview | CORS-free, one place for retries/timeouts, keys stay in Rust + keychain and never reach the frontend. Frontend only sees a token Channel. |
| All Muya writes via one edit-bridge | Every AI feature (and image paste, and search-replace) funnels through one module — one place to fix cursor/undo regressions. |
| Print-to-PDF, not a PDF lib | Typora itself uses the print pipeline; native and free. |
| pandoc by detection, not bundling | 100 MB payload for a power-user feature; detect-and-instruct is the lazy correct v1. |
| Ghost text default-off | Sends keystrokes to third parties by default is the wrong default; opt-in. |

## 5. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | Muya pre-1.0 API churn | Pin exact version; vendor/patch via `pnpm patch` if needed (MIT); upgrades are a deliberate task, not incidental. |
| 2 | **No public granular edit API** — AI insert/replace may require full-document `setContent`, losing undo/cursor | Phase 0 spike gates this. Fallback: full replace + cursor restore by path for v1; proper fix is a small API addition to a vendored fork. |
| 3 | Upstream repo churn (standalone repo archived into monorepo, maintenance turmoil in the MarkText project) | We consume the npm artifact only; coupling is one pinned dependency. Worst case, vendor the source and own it. |
| 4 | Local-model quality for long-doc editing | Ollama is positioned for autocomplete + short transforms; docs steer long-doc work to cloud models. |
| 5 | Ghost-text latency on slow hardware | Idle debounce + fast-model requirement + cancellable streams. |
| 6 | PDF fidelity edge cases (Mermaid/PlantUML pagination) | Print CSS iteration in Phase 5; acceptable imperfection documented in release notes. |

## 6. Testing & review gates

- Rust: unit tests for fs (atomic writes, watcher), ai_proxy (mock SSE server),
  secrets (round-trip, no plaintext fallback).
- TS: vitest for context-builder (token budget truncation), edit-bridge logic
  against a Muya fixture, diff-popover word-diff.
- One Playwright smoke test (Phase 5). No sprawling e2e suite.
- Per global workflow rules: AI-provider code (secrets, network) goes through
  `/review` before merge; feature branches + conventional commits; lint + tests
  before every commit.

## 7. Effort & sequencing

Solo-developer estimates, assuming the Phase 0 spike passes:

| Phase | Duration | Cumulative |
| --- | --- | --- |
| 0 Spike | ~1 wk | 1 wk |
| 1 Editor core | 2–3 wk | 3–4 wk |
| 2 Typora-parity chrome | 3–4 wk | 6–8 wk |
| 3 AI foundation | 1–2 wk | 7–10 wk |
| 4 AI features | 3–4 wk | 10–14 wk |
| 5 Export & release | 2–3 wk | **12–17 wk (~3–4 months)** |

Ship earlier by cutting: Phase 4 items are independent (chat alone is shippable at
week ~8); themes beyond GitHub/Night can trail; non-HTML export is a v0.2 feature.
