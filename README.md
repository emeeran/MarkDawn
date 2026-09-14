# Notepad

A Typora-style seamless Markdown editor with AI built in. Tauri 2 + React + TypeScript,
editor engine [Muya](https://github.com/marktext/muya) (`@muyajs/core` — the engine
extracted from MarkText, the open-source Typora clone).

![status](https://img.shields.io/badge/status-v0.1.0%20MVP-blue)

## Run it

Prereqs: Node 22+, Rust 1.77+, Tauri 2 system deps (`webkit2gtk-4.1` on Linux).

```sh
npm install
npm run tauri dev        # dev app with hot reload
npm run tauri build      # signed-ish release bundle for your OS
```

Optional: [pandoc](https://pandoc.org) on PATH enables Word/LaTeX/RTF/EPUB export
(auto-detected). [Ollama](https://ollama.com) on `localhost:11434` gives zero-config
local AI.

## Features

**Editor (Typora parity)**
- Seamless live WYSIWYG Markdown — CommonMark + GFM, inline math (KaTeX), Mermaid,
  Vega-Lite, PlantUML, Prism code blocks, footnotes, front matter, tables
- Tabs, autosave (500 ms debounce, atomic temp+rename writes), external-change banner
- File tree workspace, outline/TOC, find & replace (regex / case / whole word)
- 4 themes (GitHub, Night, Newsprint, Pixyll), focus mode, typewriter mode
- Command palette (⌘K) + quick file open (⌘P)
- Images: insert via picker, stored as document-relative paths (portable Markdown)
- Export: HTML (self-contained, themed), PDF (print pipeline), DOCX/LaTeX/RTF/EPUB (pandoc)

**AI**
- Provider-agnostic: Anthropic, OpenAI, Ollama (local). Keys live **only in the OS
  keychain** — they never reach the webview or settings.json; all HTTP runs in Rust
- Chat sidebar with document context (auto head/tail truncation around selection)
- Select text → floating quick actions (improve, grammar, shorter, longer, bullets,
  summarize, translate, custom) → **streaming word-diff popover** → Apply / Discard
- Ghost-text autocomplete (Tab to accept) — **off by default**
- `NOTEPAD.md` in the workspace root is auto-sent as writing instructions

**Shortcuts**: ⌘K palette · ⌘P files · ⌘F find · ⌘S save · ⌘N new · ⌘W close ·
⌘B sidebar · ⌘/ AI panel · ⌘⇧F focus · ⌘⌥T typewriter · ⌘, settings

## Architecture

```
src/                     React frontend
├── editor/              Muya wrapper + edit-bridge (single owner of all editor writes)
├── ai/                  streaming client, context builder, prompts, word-diff
├── panels/              file tree, outline, chat, find bar, palette, diff popover
├── commands/            command registry (palette actions)
├── stores/              zustand: settings, tabs, workspace, chat, toast
└── themes/              theme CSS (also inlined into HTML export)
src-tauri/               Rust core
└── src/
    ├── fs.rs            atomic writes, watcher (debounced fs-changed), recents, settings
    ├── secrets.rs       keychain (set/delete/status only — never readable from JS)
    ├── ai_proxy.rs      streaming SSE/NDJSON proxy: anthropic | openai | ollama
    └── export.rs        pandoc
```

Data flow: Muya `json-change` → `getMarkdown()` → debounced atomic save.
AI output returns through the edit-bridge so undo/cursor stay coherent (synthetic
paste event for multi-block Markdown, native `execCommand` for inline text).

## Tests

```sh
npm test                 # vitest: word-diff, context builder, prompts (15 tests)
cd src-tauri && cargo test   # atomic write guarantees
```

### E2E

`e2e/smoke.spec.ts` needs `@playwright/test`, `tauri-driver`, and WebKitWebDriver
(`webkit2gtk-4.1` provides it on most distros via `webkitdriver`/`WebKitWebDriver`).
Not installed by default — see [tauri-driver docs](https://docs.rs/tauri-driver).

## Known ceilings (deliberate v1 simplifications)

- Inline AI edits use `document.execCommand('insertText')` + synthetic paste events
  (deprecated-but-universal APIs); revisit if WebKit drops them
- Word-diff is O(n·m) LCS — fine for selection-sized texts
- Clipboard *paste* of image data isn't wired (insert via picker is); image paths in
  Markdown are doc-relative, not copy-managed
- Multi-block AI inserts inside a single paragraph fall back to inline insertion if
  the synthetic paste path fails
- Updater not wired (needs signing keys + a release server); `tauri-plugin-updater`
  at release time

## Security notes

- API keys: OS keychain only (`keyring` crate), frontend gets a boolean, never the key
- Chat/model output rendered through Muya's DOMPurify-sanitized renderer
- No secrets in settings.json, no `.env`, nothing hardcoded
