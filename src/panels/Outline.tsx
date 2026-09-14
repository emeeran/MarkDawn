import type { ITocItem } from '@muyajs/core'

export function Outline({ toc }: { toc: ITocItem[] }) {
  function jump(item: ITocItem) {
    const host = document.querySelector('.editor-host')
    if (!host) return
    // Match a rendered heading by text; slugs are internal block ids, not DOM ids.
    const headings = host.querySelectorAll('h1,h2,h3,h4,h5,h6')
    for (const h of headings) {
      if ((h.textContent ?? '').trim() === item.content.trim()) {
        h.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return
      }
    }
  }

  if (toc.length === 0) return <div className="panel-empty">No headings yet</div>
  return (
    <div className="outline">
      {toc.map((item) => (
        <div
          key={item.slug}
          className="outline-item"
          style={{ paddingLeft: (item.lvl - 1) * 12 + 10 }}
          onClick={() => jump(item)}
          title={item.content}
        >
          {item.content || '∅'}
        </div>
      ))}
    </div>
  )
}
