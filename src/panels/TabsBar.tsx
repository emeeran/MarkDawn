import { useTabs } from '../stores/tabs'

export function TabsBar() {
  const { tabs, activeId, setActive, close } = useTabs()
  if (tabs.length === 0) return null
  return (
    <div className="tabs-bar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeId ? 'active' : ''}`}
          onClick={() => setActive(t.id)}
          onMouseDown={(e) => { if (e.button === 1) void close(t.id) }}
          title={t.path ?? 'untitled'}
        >
          <span className="tab-title">{t.title}</span>
          <button
            className="tab-close"
            onClick={(e) => { e.stopPropagation(); void close(t.id) }}
          >
            {t.dirty ? '●' : '✕'}
          </button>
        </div>
      ))}
    </div>
  )
}
