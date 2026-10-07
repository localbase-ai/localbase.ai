import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { API_URL, API_PORT, APP_PORT } from '../tools/ports.js'

export default defineConfig({
  plugins: [react()],
  // Lets the app load vizzes from the API origin (see src/lib/vizOrigin.js).
  define: { __LB_API_PORT__: JSON.stringify(API_PORT) },
  base: './',
  server: {
    port: APP_PORT,
    strictPort: false,
    // Nothing may frame the app except itself. Without this, any website could
    // load localhost in a hidden iframe and drive the UI with forged input.
    headers: {
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'",
    },
    proxy: {
      '/api': { target: API_URL, changeOrigin: true },
      // `/viz/:id` is a client-side route (src/lib/router.js), so the app
      // shell answers it. Viz *files* are deliberately NOT proxied, and nor are
      // /data or /projects: vizzes load from the API's own origin (see
      // src/lib/vizOrigin.js). Proxying them would let a viz page reopen
      // itself on this origin, inside the app's trust boundary.
      '/viz': {
        target: API_URL,
        bypass: () => '/index.html',
      },
      '/health': { target: API_URL, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: '.',
    rollupOptions: {
      external: ['electron']
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tools': path.resolve(__dirname, '../tools'),
    },
    extensions: ['.mjs', '.js', '.jsx', '.json', '.ts', '.tsx'],
  },
})
