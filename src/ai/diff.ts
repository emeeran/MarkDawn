export type DiffOp = { type: 'same' | 'del' | 'add'; text: string }

/**
 * Word-level diff via LCS dynamic programming.
 * ponytail: O(n·m) on word tokens — fine for selections (≤ a few thousand
 * words). Swap for a Myers diff if whole documents ever flow through here.
 */

/** Above n·m the (n+1)×(m+1) table approaches a renderer-crashing
 *  allocation (a 10k-word expand ≈ 400 MB) — degrade to a whole-span
 *  replace instead, which is always correct, just not minimal. */
const LCS_CELL_CAP = 4_000_000

export function wordDiff(oldText: string, newText: string): DiffOp[] {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const n = a.length
  const m = b.length

  if (n * m > LCS_CELL_CAP) {
    const ops: DiffOp[] = []
    if (n > 0) push(ops, 'del', a.join(''))
    if (m > 0) push(ops, 'add', b.join(''))
    return ops
  }

  // LCS length table. Tokens carry trailing whitespace, so equality is on the
  // word core only ("hello" ≡ "hello ").
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = word(a[i]) === word(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // Walk to ops, then merge adjacent same-type ops
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (word(a[i]) === word(b[j])) {
      push(ops, 'same', a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(ops, 'del', a[i++])
    } else {
      push(ops, 'add', b[j++])
    }
  }
  while (i < n) push(ops, 'del', a[i++])
  while (j < m) push(ops, 'add', b[j++])
  return ops
}

function push(ops: DiffOp[], type: DiffOp['type'], text: string) {
  const last = ops.at(-1)
  if (last && last.type === type) last.text += text
  else ops.push({ type, text })
}

/** Token with its trailing whitespace stripped. */
function word(t: string): string {
  return t.replace(/\s+$/, '')
}

function tokenize(s: string): string[] {
  // Whitespace travels with the word before it, so the LCS aligns on words
  // rather than on interchangeable space tokens.
  return s.match(/[^\s]+\s*|\s+/g) ?? []
}
