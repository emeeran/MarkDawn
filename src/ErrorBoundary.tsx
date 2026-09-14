import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * A render crash used to blank the webview with nothing in stderr (release
 * builds) — undiagnosable. Now it renders the failure and a way out.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Notepad crashed:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="welcome" role="alert">
        <h1>Something broke</h1>
        <pre style={{ whiteSpace: 'pre-wrap', maxWidth: '80ch' }}>{this.state.error.message}</pre>
        <div className="welcome-actions">
          <button className="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button onClick={() => window.location.reload()}>Reload app</button>
        </div>
      </div>
    )
  }
}
