# MarkDawn User Manual

A Typora-style seamless Markdown editor with AI built in. Everything here is
accurate to MarkDawn 0.1.2.

---

## Contents

1. [Installation](#installation)
2. [Launching & opening files](#launching--opening-files)
3. [The interface](#the-interface)
4. [Working with documents](#working-with-documents)
5. [Editing & formatting](#editing--formatting)
6. [Images](#images)
7. [Find, replace & workspace search](#find-replace--workspace-search)
8. [Views, themes & text size](#views-themes--text-size)
9. [Command palette & quick open](#command-palette--quick-open)
10. [AI features](#ai-features)
11. [Read aloud](#read-aloud)
12. [Exporting](#exporting)
13. [Settings reference](#settings-reference)
14. [Where your data lives](#where-your-data-lives)
15. [Keyboard shortcuts](#keyboard-shortcuts)
16. [Troubleshooting & FAQ](#troubleshooting--faq)

---

## Installation

MarkDawn is built from source (Tauri 2 + React + TypeScript).

**Prerequisites**

- Node.js 22+
- Rust 1.77+
- Tauri 2 system dependencies — on Linux/Debian:
  `webkit2gtk-4.1`, `libgtk-3`, `libayatana-appindicator3`, `librsvg2`
  (the CI workflow installs exactly `libwebkit2gtk-4.1-dev libgtk-3-dev
  libayatana-appindicator3-dev librsvg2-dev`)

**Build and run**

```sh
npm install
npm run tauri dev        # dev app with hot reload
npm run tauri build      # release bundle for your OS
```

**Linux deb package**

```sh
npm run deb
```

Builds the deb and then patches its desktop entry to `Exec=markdawn %f` (Tauri
omits `%f`, which breaks Open With → MarkDawn with a file), and registers the
`text/markdown` and `text/plain` mime types so MarkDawn appears in your file
manager's Open With list. File associations for `.md`, `.markdown`, `.txt` are
also declared in the bundle config.

**Optional extras (auto-detected, install only if you want them)**

| Tool | Enables | Install |
| --- | --- | --- |
| [pandoc](https://pandoc.org) | DOCX / ODT / LaTeX / RTF / EPUB export | package manager or pandoc.org |
| [Ollama](https://ollama.com) | local AI on `localhost:11434` | ollama.com |
| [edge-tts](https://pypi.org/project/edge-tts/) | read aloud | `pip install edge-tts` |
| `mpv` or `ffplay` | read-aloud playback that **Stop** can kill | package manager |

**Command line**

```sh
markdawn                 # empty window (Welcome screen if no recent files)
markdawn notes.md        # open one or more files (.md, .markdown, .txt must exist)
```

Launching a second time while MarkDawn is running does not start a second
instance — the files from the second launch are forwarded to the running window.

---

## Launching & opening files

- **Welcome screen** — shown when no tabs are open, with your recent files
  (capped at 15 entries) and a *Clear recent history* action.
- **File ▸ Open…** (⌘O) — pick one or more files.
- **File ▸ Open Folder…** (⇧⌘O) — open a folder as the workspace; it appears in
  the file-tree sidebar.
- **Drag & drop** — drop `.md` / `.markdown` / `.txt` files on the window to
  open them; dropping an image offers to insert it into the current document.
- **Command line** — `markdawn foo.md` works on first launch and on later ones.

---

## The interface

- **Editor** — the whole window is the page. You type Markdown; it renders live
  (CommonMark + GFM, KaTeX math, Mermaid, Vega-Lite, PlantUML, Prism code
  blocks, footnotes, front matter, tables). ⌘/ toggles **source mode** (a plain
  raw-Markdown textarea).
- **Tabs bar** — one tab per open document, dirty-dot indicator, middle-click to
  close.
- **Sidebar** (⌘⇧L toggles) — two tabs: **Files** (workspace tree: create
  file/folder, rename, move to trash) and **Outline** (⌥⌘O toggles; click a
  heading to jump). Drag the divider to resize; double-click it to fold.
- **Word count pill** — bottom corner, hidden on an empty document; toggle from
  View ▸ Word Count.
- **Find bar** — ⌘F, floats over the editor.
- **Chat panel** — ⌘⇧A opens the AI sidebar.
- **Transform popover** — select text to get floating AI quick actions.
- **Toasts** — errors and notices appear bottom-center; an error boundary
  catches crashes so the window stays usable.

---

## Working with documents

**Save behavior — you rarely think about saving.**

- Edits autosave 500 ms after you stop typing, using an atomic write
  (temp file + rename) so a crash mid-write can't corrupt the file.
- **⌘S** saves immediately (an untitled document goes to Save As).
- **Quitting** flushes every pending save first; the app refuses to exit until
  the handoff completes (a 3-second watchdog force-exits if the webview is
  stuck).
- **Closing a dirty tab** saves it first; if the save **fails**, the tab stays
  open with your text intact. If Save-As is **cancelled**, the tab also stays
  open.
- **Untitled dirty tabs** with nowhere to go are recovered to the app data dir
  (`recovery/`) on quit — nothing is silently dropped.
- **File changed on disk** — if an external program edits the file you have
  open, a banner offers *Reload from disk* / *Keep mine* (your own saves never
  trigger it).

**File menu actions**

| Action | Shortcut | Notes |
| --- | --- | --- |
| New File | ⌘N | untitled tab |
| Open… | ⌘O | |
| Open Folder… | ⇧⌘O | sets the workspace |
| Save | ⌘S | untitled → Save As |
| Save As… | ⇧⌘S | |
| Export | — | see [Exporting](#exporting) |
| Preferences… | ⌘, | |
| Close Tab | ⌘W | |
| Reopen Closed Tab | ⌘⇧T | |
| Quit | — | flushes pending saves first |

---

## Editing & formatting

Everything lives in the native menu bar (and most of it in the command palette).

**Paragraph menu** — ⌘1…⌘6 headings 1–6, ⌘⇧Q blockquote, ⌘⇧8 bullet list,
⌘⇧7 ordered list, ⌘⇧9 task list, ⌘⇧K code block, ⌘⇧M math block, ⌥⇧T table,
Horizontal Rule (no shortcut).

**Format menu** — ⌘B bold, ⌘I italic, ⌘⇧C inline code, ⌥⇧5 strikethrough,
⌘\\ clear formatting.

**Edit menu** — undo/redo (editor history), native cut/copy/paste/select-all, ⌘F find & replace,
⌥⌘F search in workspace, and the Read Aloud submenu.

Supported Markdown surface: CommonMark 0.31 + GFM, inline math (KaTeX),
Mermaid, Vega-Lite, PlantUML, Prism-highlighted code blocks, footnotes, YAML
front matter, tables. Clicking an `http(s)` link opens your system browser.

---

## Images

Three ways in, one storage story:

- **Paste** (⌘V) or **drag-drop** an image into the editor — the file is copied
  to `<document>_assets/` next to your document and referenced
  document-relative, so the Markdown stays portable with its assets. Pasted
  images land at the caret and render immediately. Pasting from the clipboard
  uses an OS-clipboard fallback (wl-paste → xclip) with a 3-second guard,
  which works around a WebKitGTK clipboard gap; the fallback also reads
  copied image *files* (`text/uri-list` / GNOME copied-files) when the
  webview can't see them, and validates image magic bytes before writing.
- **Picker** — the image insert picker references the picked file **in place**
  (it is *not* copied into the assets folder).
- Resizing an image in the editor persists as an `<img>` tag with the original
  path restored in the saved Markdown.

Display is capped at 20 MB per image.

---

## Find, replace & workspace search

- **Find & Replace** (⌘F) — operates on the current document with regex, case
  and whole-word options.
- **Search in Workspace** (⌥⌘F) — literal (non-regex) substring search across
  the workspace's `.md` / `.markdown` / `.txt` files. Clicking a hit opens the
  file and pre-fills the find bar. Budgets: max 200 hits, 4 000 files, depth 12,
  512 KB per file, 20 hits per file; `.git`, `node_modules`, `target`, `dist`
  are skipped.

---

## Views, themes & text size

- **Themes** (Themes menu): *Auto (light/dark)* — follows your OS appearance —
  plus **GitHub**, **Night**, **Newsprint**, **Pixyll**.
- **Focus mode** (⌘⇧F) — dims everything but the active line.
- **Typewriter mode** (⌥⌘T) — keeps the active line vertically centered.
- **Source mode** (⌘/) — raw Markdown textarea.
- **Ghost Text Autocomplete** (⌥⌘G) — Tab-to-accept AI completions. **Off by
  default**; enabling sends text to your configured AI provider.
- **Text size** — ⌘= bigger, ⌘- smaller, ⌘0 reset (view zoom, persisted).
- Window position and size persist across restarts.

---

## Command palette & quick open

- **⌘K** — every menu action, searchable.
- **⌘P** — quick-open files by name (workspace + recents).

---

## AI features

### Providers

Settings ▸ AI supports **Anthropic**, **OpenAI**, **Groq**, and **Ollama**
(local). API keys are stored **only in your OS keychain** — the app stores a
boolean "configured" flag in the webview; the key itself is never sent to the
frontend or written to `settings.json`. All provider HTTP happens in the Rust
core, not the webview. Model lists are fetched from the provider; known
non-chat models (guard/whisper/embed/…) are filtered out. Ollama needs no key;
its server URL is restricted to loopback/private hosts.

### Chat sidebar (⌘⇧A)

- Real multi-turn memory — the last 10 messages ride along with each request.
- Context: the current document (default, truncated to a 12 000-char budget) or
  selection-only; if text is selected, the document window centers on it.
- Your document outline is included, and a `NOTEPAD.md` in the workspace root
  is injected as standing writing instructions (style guide, persona, …).
- Streams token-by-token; Stop cancels. Transcripts persist across restarts;
  each reply has *Insert at cursor*, *Replace selection*, and *Copy*.

### Quick actions (select text → floating bar)

*Improve writing · Fix grammar · Make shorter · Make longer · Bullet points ·
Summarize · Translate… · Custom prompt…*

The rewrite streams into a **word-diff popover** (changes highlighted) with
Apply / Discard / Stop. Applying goes through the editor's edit-bridge, so it
lands as a normal undoable edit. If you changed the selection while the model
was running, Apply is refused (it would corrupt the wrong span).

### Ghost text

Off by default (⌥⌘G or Settings). When on, a grey completion appears as you
type at the end of a paragraph; **Tab** accepts, any other key dismisses.

**Prompt-injection reality check:** document text, selections, and `NOTEPAD.md`
are sent to the model verbatim, and its output can be applied with one click.
Treat files from untrusted sources accordingly.

---

## Read aloud

Edit ▸ Read Aloud: **Read Document**, **Read Selection**, **Read From Cursor**,
**Stop Reading**.

Requires [edge-tts](https://pypi.org/project/edge-tts/) (`pip install
edge-tts`). Voice, rate, pitch and volume are configured in Settings, with the
voice list fetched from edge-tts (natural voices sorted first). Long text is
capped at 30 000 characters per request. Playback tries `mpv`, then `ffplay`,
then `xdg-open`; with `xdg-open` the desktop's default player owns the audio,
so **Stop cannot kill it** — install mpv or ffplay for stoppable playback.
Temporary synth files in `/tmp` are janitored hourly and on startup.

---

## Exporting

File ▸ Export:

| Format | Engine | Notes |
| --- | --- | --- |
| HTML… | built-in | self-contained single file: theme CSS inlined, TOC `<nav>` |
| PDF… | print pipeline | uses your browser-style print dialog; theme applied |
| Word (.docx)… | pandoc | needs pandoc on PATH |
| OpenDocument (.odt)… | pandoc | |
| LaTeX… | pandoc | |
| RTF… | pandoc | |
| EPUB… | pandoc | |

Every export **refuses to overwrite** an existing destination — you'll get an
error instead ("already exists — remove or rename it first").

---

## Settings reference

(File ▸ Preferences…, ⌘, — persisted as `settings.json` in the app config dir.)

| Group | Options |
| --- | --- |
| Appearance | theme (auto/github/night/newsprint/pixyll), editor font family, font size, line height, paragraph alignment |
| Editor | ghost text autocomplete on/off |
| AI | provider, API key (keychain), model (fetched from provider), Ollama server URL, chat context mode |
| Read aloud | voice, rate, pitch, volume |

---

## Where your data lives

| Data | Location |
| --- | --- |
| settings.json | app config dir |
| chat history | `chat-history.json` in the app config dir (plain JSON) |
| recent files | app config dir (15-entry cap) |
| recovered untitled tabs | `recovery/` in the app data dir |
| image assets | `<document>_assets/` next to your document |
| API keys | OS keychain only — never in a file |

There is no telemetry, no network access beyond the AI providers you configure,
Ollama, model/voice listing, and reading documents you open.

---

## Keyboard shortcuts

⌘ means Ctrl on Linux/Windows. (From the native menu — the palette exposes the
same actions.)

**File**

| | |
| --- | --- |
| New File | ⌘N |
| Open… | ⌘O |
| Open Folder… | ⇧⌘O |
| Save | ⌘S |
| Save As… | ⇧⌘S |
| Preferences… | ⌘, |
| Close Tab | ⌘W |
| Reopen Closed Tab | ⌘⇧T |

**Edit**

| | |
| --- | --- |
| Undo | ⌘Z |
| Redo | ⌘⇧Z |
| Find / Replace… | ⌘F |
| Search in Workspace… | ⌥⌘F |

**Paragraph**

| | |
| --- | --- |
| Heading 1–6 | ⌘1 … ⌘6 |
| Blockquote | ⌘⇧Q |
| Ordered List | ⌘⇧7 |
| Bullet List | ⌘⇧8 |
| Task List | ⌘⇧9 |
| Code Block | ⌘⇧K |
| Math Block | ⌘⇧M |
| Table | ⌥⇧T |

**Format**

| | |
| --- | --- |
| Bold | ⌘B |
| Italic | ⌘I |
| Inline Code | ⌘⇧C |
| Strikethrough | ⌥⇧5 |
| Clear Formatting | ⌘\\ |

**View**

| | |
| --- | --- |
| Source Mode | ⌘/ |
| Focus Mode | ⌘⇧F |
| Typewriter Mode | ⌥⌘T |
| Ghost Text Autocomplete | ⌥⌘G |
| Bigger / Smaller / Reset Text | ⌘= / ⌘- / ⌘0 |
| File Tree | ⌘⇧L |
| Outline | ⌥⌘O |
| AI Panel | ⌘⇧A |
| Command Palette… | ⌘K |
| Quick Open… | ⌘P |

**Read Aloud**

| | |
| --- | --- |
| Read Document | ⌘⇧R |
| Read Selection | ⌥⌘R |
| Read From Cursor | ⌥⌘⇧R |
| Stop Reading | ⌥⌘S |

Export items have no shortcuts — use the menu or ⌘K.

---

## Troubleshooting & FAQ

**Export shows "pandoc not found"** — install pandoc and make sure it's on
PATH, then retry. It's detected at each use.

**Read aloud does nothing** — install edge-tts (`pip install edge-tts`).
Check Settings ▸ Read aloud for the detected voice list; an empty list means
the synth subprocess failed.

**Stop doesn't stop playback** — your system has neither mpv nor ffplay, so
playback went through `xdg-open` and the desktop player owns it. Install
`mpv` or `ffplay`.

**Ollama refuses my server URL** — only loopback/private hosts are allowed
(SSRF guard). A publicly-hosted Ollama endpoint will not work.

**A pasted image doesn't show** — display is capped at 20 MB per image, and
the picker path references files in place (moving the original breaks the
link). Paste/drop images are safer: they're copied into `<doc>_assets/`.

**My API key disappeared after an update** — keys live in the OS keychain
keyed to the app; if the keychain is locked or the identifier changed, you'll
need to re-enter it in Settings.

**I closed a tab and lost text** — you shouldn't be able to: a failed save
keeps the tab open, and untitled dirty tabs are recovered to `recovery/` in the
app data dir on quit. Check there first.

**The window lost its size/position** — it's remembered per display by the
window-state plugin; moving it once and quitting normally re-persists it.

**Markdown from an untrusted source** — MarkDawn renders it sanitized
(DOMPurify), keeps scripts out via CSP, and confines file access to what you
opened — but AI features will happily read that text and apply model output,
so review diffs before clicking Apply.
