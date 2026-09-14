import type { ITocItem } from '@muyajs/core'

export function Outline({ toc }: { toc: ITocItem[] }) {
  function jump(item: ITocItem, occurrence: number) {
    const host = document.querySelector('.editor-host')
    if (!host) return
    // Match a rendered heading by text; slugs are internal block ids, not DOM
    // ids. Duplicate headings jump by occurrence index — text match alone
    // always landed on the first.
    const matching = [...host.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(
      (h) => (h.textContent ?? '').trim() === item.content.trim(),
    )
    matching[occurrence]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  if (toc.length === 0) return <div className="panel-empty">No headings yet</div>
  const seen = new Map<string, number>()
  return (
    <div className="outline">
      {toc.map((item, i) => {
        const occurrence = seen.get(item.content) ?? 0
        seen.set(item.content, occurrence + 1)
        return (
          <div
            key={item.slug || i}
            className="outline-item"
            style={{ paddingLeft: (item.lvl - 1) * 12 + 10 }}
            onClick={() => jump(item, occurrence)}
            title={item.content}
          >
            {item.content || '∅'}
          </div>
        )
      })}
    </div>
  )
}
