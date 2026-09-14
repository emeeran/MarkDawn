import { useMemo } from 'react'
import { useTabs } from '../stores/tabs'

/** Typora-style word count: a quiet pill in the bottom-right corner. */
export function WordCount() {
  const markdown = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.markdown)
  const stats = useMemo(() => {
    const md = markdown ?? ''
    const words = md.split(/\s+/).filter(Boolean).length
    const chars = md.length
    const lines = md ? md.split('\n').length : 0
    return { words, chars, lines, empty: !markdown }
  }, [markdown])

  if (stats.empty) return null
  return (
    <div className="word-count" title={`${stats.chars.toLocaleString()} characters · ${stats.lines.toLocaleString()} lines`}>
      {stats.words.toLocaleString()} words
    </div>
  )
}
