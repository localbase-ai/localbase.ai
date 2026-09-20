import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { API_URL, APP_PORT } from '../tools/ports.js'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: APP_PORT,
    strictPort: false,
    proxy: {
      '/api': { target: API_URL, changeOrigin: true },
      // `/viz` is TWO things and the proxy has to tell them apart:
      //   /viz/:id       a client-side route (see src/lib/router.js) — the app
      //                  shell, which then loads the viz in an iframe
      //   /viz/:id.html  the file itself, served by Express, plus any assets
      //                  a viz requests alongside it
      // Proxying the whole prefix sent the app route to Express as well, which
      // has no such file and answered "Cannot GET /viz/foo" — so the documented
      // way to open a viz was the one URL that could not work.
      '/viz': {
        target: API_URL,
        changeOrigin: true,
        // Returning a path serves that instead of proxying; null proxies normally.
        bypass(req) {
          const urlPath = req.url.split('?')[0];
          // A file extension means a real asset. Everything else is a route.
          return /\.[a-z0-9]+$/i.test(urlPath) ? null : '/index.html';
        }
      },
      // Vizzes run in an iframe served from this origin and fetch their data
      // via absolute paths — SQLite under '/data/...', precomputed JSON under
      // '/projects/...'. Without these, Vite's SPA fallback answers with
      // index.html and the viz fails on the HTML it gets back.
      '/data': { target: API_URL, changeOrigin: true },
      '/projects': { target: API_URL, changeOrigin: true },
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
