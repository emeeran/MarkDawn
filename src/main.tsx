import React from 'react'
import ReactDom from 'react-dom/client'
import { App } from './App'
import { useToast } from './stores/toast'
import './styles.css'
import './themes/github.css'
import './themes/night.css'
import './themes/newsprint.css'
import './themes/pixyll.css'

// Surface webview errors visibly (toast + title) instead of failing silently.
window.addEventListener('error', (e) => {
  document.title = `ERR: ${e.message}`
  useToast.getState().show(`Error: ${e.message}`)
})
window.addEventListener('unhandledrejection', (e) => {
  document.title = `REJ: ${e.reason}`
  useToast.getState().show(`Error: ${e.reason}`)
})

ReactDom.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
