// Single source of truth for LocalBase's dev-server ports.
//
// Why 9220/9221 and not the ecosystem defaults 3000/5173: LocalBase is
// installed alongside whatever else you already build on this machine, and
// 3000 (Express/Next) and 5173 (Vite) are the two most contested ports in
// Node development. Defaulting to them means LocalBase picks a fight with
// every other project on first run — and, worse, `localbase stop` used to
// sweep whoever held :3000, which could be somebody else's dev server.
//
// 9220/9221 are adjacent (remember one, the other is +1) and unclaimed:
// nothing above 9209 is registered in /etc/services, and 9229 is left free
// because that is Node's --inspect debugger port.
//
// Override either with LOCALBASE_API_PORT / LOCALBASE_APP_PORT.

export const DEFAULT_API_PORT = 9220;
export const DEFAULT_APP_PORT = 9221;

// Below 1024 needs root; 49152+ is the ephemeral range the OS hands out to
// outbound connections, so binding there invites a random collision. Anything
// outside that window is refused and we fall back to the default.
export const MIN_PORT = 1024;
export const MAX_PORT = 49151;

/**
 * Resolve one port from an env value, falling back when it is absent or unusable.
 * @param {string|undefined} value Raw env value
 * @param {number} fallback Default port
 * @returns {number}
 */
export function resolvePort(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  if (n < MIN_PORT || n > MAX_PORT) return fallback;
  return n;
}

/**
 * Resolve both ports from an environment object. Pure — pass a fake env to test.
 * @param {Record<string,string|undefined>} [env]
 * @returns {{apiPort: number, appPort: number, apiUrl: string, appUrl: string, allowedOrigins: string[]}}
 */
export function resolvePorts(env = process.env) {
  const apiPort = resolvePort(env.LOCALBASE_API_PORT, DEFAULT_API_PORT);
  const appPort = resolvePort(env.LOCALBASE_APP_PORT, DEFAULT_APP_PORT);
  return {
    apiPort,
    appPort,
    apiUrl: `http://localhost:${apiPort}`,
    appUrl: `http://localhost:${appPort}`,
    // Origins the API accepts: both ports, both loopback spellings.
    allowedOrigins: [
      `http://localhost:${appPort}`,
      `http://localhost:${apiPort}`,
      `http://127.0.0.1:${appPort}`,
      `http://127.0.0.1:${apiPort}`,
    ],
  };
}

const resolved = resolvePorts();

export const API_PORT = resolved.apiPort;
export const APP_PORT = resolved.appPort;
export const API_URL = resolved.apiUrl;
export const APP_URL = resolved.appUrl;
export const ALLOWED_ORIGINS = resolved.allowedOrigins;
