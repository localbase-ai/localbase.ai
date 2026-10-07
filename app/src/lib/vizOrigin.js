// Where viz pages are loaded from.
//
// In the operator app (Vite dev server) vizzes come from the API server's
// origin — same host, API port — so a viz can't touch the app's page or make
// writes (the API only accepts those from the app's origin). See
// tools/server/viz-bridge.js for how keys and scrolling cross that boundary.
//
// The read-only preview serves the built app and the vizzes from one port, so
// there they stay same-origin.
/* global __LB_API_PORT__ */
const apiPort = typeof __LB_API_PORT__ !== 'undefined' ? __LB_API_PORT__ : null

export const VIZ_ORIGIN = import.meta.env.DEV && apiPort
  ? `${window.location.protocol}//${window.location.hostname}:${apiPort}`
  : window.location.origin

/** Absolute URL for a workspace path like "viz/foo.html" or "/viz/foo.html". */
export const vizUrl = (path) => `${VIZ_ORIGIN}/${String(path).replace(/^\//, '')}`

/** True when a postMessage came from a viz (or the app itself, for same-origin preview). */
export const isVizMessage = (e) => e.origin === VIZ_ORIGIN || e.origin === window.location.origin

// Applied to every viz iframe. No allow-top-navigation: a viz can't navigate
// the app away. allow-same-origin keeps the viz on its own (API) origin so it
// can still load /data; popups let its links open in new tabs, but they stay
// sandboxed (no allow-popups-to-escape-sandbox).
export const VIZ_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-downloads allow-modals'
