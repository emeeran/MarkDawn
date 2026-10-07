// postinstall: shrink @muyajs/core's bundled payload.
// 1. lib/es/index.js maps ~300 prism languages to dynamic imports — vite
//    emits every mapped chunk (~2.2M) even though only a handful are ever
//    loaded. Drop all but the curated KEEP set.
// 2. lib/core.css ships ttf+woff+woff2 for every KaTeX face (~2.2M of
//    redundant formats). Emit an app-owned woff2-only css into src/assets/
//    with the needed fonts/icons copied alongside.
// muya is pinned exact (see CLAUDE.md), so this is deterministic; if it is
// ever upgraded, re-verify the keep list covers the require-chains.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'node_modules/@muyajs/core/lib')
const out = join(root, 'src/assets')

// Languages worth shipping in a markdown editor + their require-chain deps
// (markup-templating for php, c for cpp, clike for the C-family, json for
// json5, markup for jsx/markdown).
const KEEP = new Set([
  'markup', 'css', 'clike', 'javascript', 'typescript', 'jsx', 'tsx',
  'json', 'json5', 'yaml', 'toml', 'ini', 'bash', 'python', 'rust', 'go',
  'java', 'c', 'cpp', 'csharp', 'sql', 'xml', 'markdown', 'diff', 'lua',
  'php', 'ruby', 'kotlin', 'swift', 'docker', 'makefile', 'git', 'http',
  'markup-templating',
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
let dropped = 0
js = js.replace(ENTRY_RE, (full, lang) => (KEEP.has(lang) ? full : (dropped++, '')))
if (dropped === 0 && js.includes('prism-abap')) {
  // Nothing matched but untrimmed content is present → the layout changed.
  console.error('trim-muya: no prism entries matched — muya layout changed, investigate')
  process.exit(1)
}
writeFileSync(join(lib, 'es/index.js'), js)
console.log(`trim-muya: dropped ${dropped} prism language mappings`)

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
