import { useSettings } from '../stores/settings'
import { useTabs } from '../stores/tabs'

export function StatusBar({ wordCount }: { wordCount: number }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId))
  const settings = useSettings()

  return (
    <div className="status-bar">
      <span className="status-path" title={tab?.path ?? ''}>
        {tab?.dirty ? '● ' : ''}{tab?.path ?? (tab ? 'untitled' : 'no document')}
      </span>
      <span className="status-right">
        <span>{wordCount.toLocaleString()} words</span>
        <button
          className={settings.focusMode ? 'on' : ''}
          title="Focus mode (⌘⇧F)"
          onClick={() => settings.set('focusMode', !settings.focusMode)}
        >
          focus
        </button>
        <button
          className={settings.typewriterMode ? 'on' : ''}
          title="Typewriter mode (⌘⌥T)"
          onClick={() => settings.set('typewriterMode', !settings.typewriterMode)}
        >
          typewriter
        </button>
        <span className="status-ai">
          {settings.provider}:{settings.models[settings.provider]}
        </span>
      </span>
    </div>
  )
}
