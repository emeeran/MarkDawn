import { openUrl } from '@tauri-apps/plugin-opener'
import logo from '../assets/markdawn-logo.png'
import dedication from '../assets/dedication.jpg'
import { useToast } from '../stores/toast'

const REPO = 'https://github.com/emeeran/MarkDawn'

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="palette about-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <img src={logo} alt="MarkDawn logo" draggable={false} />
          <div>
            <h2>MarkDawn</h2>
            <p className="palette-section">
              v{__APP_VERSION__} — a Typora-style Markdown editor: seamless live preview,
              AI-assisted writing, and native speed. Free and open source.
            </p>
            <a
              href={REPO}
              onClick={(e) => {
                e.preventDefault()
                void openUrl(REPO).catch(() => useToast.getState().show('Cannot open the repository page'))
              }}
            >
              github.com/emeeran/MarkDawn
            </a>
          </div>
        </div>
        <div className="about-dedication">
          <img src={dedication} alt="In Loving Remembrance — Tariq al Fayad, 1997–2020" draggable={false} />
          <p>
            In loving remembrance of <strong>Tariq al Fayad</strong> (1997–2020).
            This app is dedicated to his memory.
          </p>
        </div>
      </div>
    </div>
  )
}
