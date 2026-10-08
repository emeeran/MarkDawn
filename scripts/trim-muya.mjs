// postinstall: shrink @muyajs/core's bundled payload.
// 1. lib/es/index.js maps ~300 prism languages to dynamic imports — vite
//    emits every mapped chunk (~2.2M) even though only a handful are ever
//    loaded. Drop all but the curated KEEP set.
// 2. lib/core.css ships ttf+woff+woff2 for every KaTeX face (~2.2M of
//    redundant formats). Emit an app-owned woff2-only css into src/assets/
//    with the needed fonts/icons copied alongside.
// muya is pinned exact (see CLAUDE.md), so this is deterministic; if it is
// ever upgraded, re-verify the keep list covers the require-chains.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'node_modules/@muyajs/core/lib')
const out = join(root, 'src/assets')

// Languages worth shipping in a markdown editor + their require-chain deps
// (markup-templating for php, c for cpp, clike for the C-family, json for
// json5, markup for jsx/markdown). latex is preloaded by muya itself at
// startup for math blocks — removing it breaks app boot (2026-10 regression).
// The rest of the tail is the require/optional/modify closure of that set:
// muya's prism resolver THROWS "depends on an unknown component" for a
// missing optional too (regex, 2026-10 regression), so every target of a
// kept language must ship. The check below enforces this — if it fires,
// add the named languages here.
const KEEP = new Set([
  'markup', 'css', 'clike', 'javascript', 'typescript', 'jsx', 'tsx',
  'json', 'json5', 'yaml', 'toml', 'ini', 'bash', 'python', 'rust', 'go',
  'java', 'c', 'cpp', 'csharp', 'sql', 'xml', 'markdown', 'diff', 'lua',
  'php', 'ruby', 'kotlin', 'swift', 'docker', 'makefile', 'git', 'http',
  'markup-templating', 'latex', 'regex', 'jsdoc', 'javadoclike', 'csp',
  'hpkp', 'hsts', 'uri', 'actionscript', 'coffeescript',
])

// 1. prism chunks. Entries are `"…/prism-<lang>[.min].js": () => import("…")`
//    separated by `,\n\t+`; trailing commas inside object literals are legal,
//    so dropping the last entry leaves valid syntax. Two entries (prism-core)
//    end in an interop `.then(...)` tail — consume it when present.
const ENTRY_RE = new RegExp(
  '"\\.\\./\\.\\./\\.\\./node_modules/prismjs/components/prism-([a-z0-9-]+?)(\\.min)?\\.js"' +
    ': \\(\\) => import\\("\\.\\./prism-[a-z0-9-]+?(?:\\.min)?-[A-Za-z0-9_-]+\\.mjs"\\)' +
    '(?:\\.then\\(\\(e\\) => /\\* @__PURE__ \\*/ Ae\\(e\\.default\\)\\))?(,)?',
  'g',
)
let js = readFileSync(join(lib, 'es/index.js'), 'utf8')
// Entries present before any trim — used by the dep-closure guard below to
// tell "we dropped it" (regression) from "muya never shipped it" (ignore).
const preTrimEntries = new Set(
  [...js.matchAll(/\n\t\t\t([a-z0-9-]+): \{[^{}]*owner: [^{}]*\}/g)].map((m) => m[1]),
)
let dropped = 0
js = js.replace(ENTRY_RE, (full, lang) => (KEEP.has(lang) ? full : (dropped++, '')))
if (dropped === 0 && js.includes('prism-abap')) {
  // Nothing matched but untrimmed content is present → the layout changed.
  console.error('trim-muya: no prism entries matched — muya layout changed, investigate')
  process.exit(1)
}
writeFileSync(join(lib, 'es/index.js'), js)
console.log(`trim-muya: dropped ${dropped} prism language mappings`)

// Also trim the language metadata for the same set: `lang in prism.languages`
// gates the loader, so dropped languages then take the built-in silent
// no-highlight path instead of rejecting with "Unknown variable dynamic
// import" (the pre-trim bundle never had a language missing from the map).
// Every metadata entry carries `owner:` — plugin config objects don't.
let metaDropped = 0
js = js.replace(/\n\t\t\t([a-z0-9-]+): \{[^{}]*owner: "[^"]*"[^{}]*\}(,)?/g, (entry, lang) => {
  if (KEEP.has(lang)) return entry
  metaDropped++
  return ''
})
writeFileSync(join(lib, 'es/index.js'), js)
console.log(`trim-muya: dropped ${metaDropped} language metadata entries`)

// Dep-closure guard: kept languages' require/optional/modify targets must not
// point at a metadata entry we dropped (the resolver throws at runtime, see
// above). Targets with no entry at all (js-extras, markup-templating) were
// never resolvable — pre-existing muya behavior, not ours to fix.
const entryRe = /\n\t\t\t([a-z0-9-]+): \{([^{}]*owner: [^{}]*)\}/g
const kept = new Set([...js.matchAll(entryRe)].map((m) => m[1]))
for (const [, lang, body] of js.matchAll(entryRe)) {
  for (const f of ['require', 'optional', 'modify']) {
    const t = body.match(new RegExp(f + ': ("[^"]*"|\\[[^\\]]*\\])'))
    for (const target of t ? [...t[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [])
      if (!kept.has(target) && preTrimEntries.has(target)) {
        console.error(`trim-muya: ${lang}.${f} -> "${target}" was dropped — add it to KEEP`)
        process.exit(1)
      }
  }
}

// 2. woff2-only font css. Per @font-face block: keep just the woff2 source;
// faces with no woff2 (DejaVu Sans Mono is ttf-only) drop entirely — the
// font-family stacks fall back to system fonts.
let css = readFileSync(join(lib, 'core.css'), 'utf8')
css = css.replace(/@font-face\{[^}]*\}/g, (block) => {
  const woff2 = block.match(/url\([^)]*\.woff2\)format\("[^"]*"\)/)
  return woff2 ? block.replace(/src:[^;}]*/, `src:${woff2[0]}`) : ''
})

const copied = new Set()
css = css.replace(/url\(\.\/assets\/([^)]+)\)/g, (full, rel) => {
  const dest = join(out, 'muya-assets', rel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(join(lib, 'assets', rel), dest)
  copied.add(rel)
  return `url(./muya-assets/${rel})`
})
writeFileSync(join(out, 'muya-core.css'), css)
console.log(`trim-muya: wrote muya-core.css (${(css.length / 1024).toFixed(0)}K) with ${copied.size} assets`)

// The lib content changed but vite's dep-optimizer hash (lockfile+config) did
// not — a stale prebundle keeps serving dropped imports. Force regeneration.
rmSync(join(root, 'node_modules/.vite'), { recursive: true, force: true })
