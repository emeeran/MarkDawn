export type DiffOp = { type: 'same' | 'del' | 'add'; text: string }

/**
 * Word-level diff via LCS dynamic programming.
 * ponytail: O(n·m) on word tokens — fine for selections (≤ a few thousand
 * words). Swap for a Myers diff if whole documents ever flow through here.
 */
export function wordDiff(oldText: string, newText: string): DiffOp[] {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const n = a.length
  const m = b.length

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

/** True when the texts are identical after collapsing whitespace. */
export function isNoOp(oldText: string, newText: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
  return norm(oldText) === norm(newText)
}
