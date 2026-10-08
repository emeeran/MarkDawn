import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import pkg from './package.json' with { type: 'json' }

// Tauri expects a fixed dev port; fail instead of picking another.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'chrome105',
    minify: 'esbuild',
    sourcemap: false,
  },
})
