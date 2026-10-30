/**
 * Shared Google OAuth 2.0 for installed ("desktop") apps.
 *
 * Every Google connector authenticates identically — only the scopes and the
 * token path differ — so the mechanics live here rather than being copied per
 * connector. `googleAuth()` below gives a connector its whole auth surface from
 * a name and a scope list. The parts worth getting right once:
 *
 *   - Google issues a refresh token ONLY on a consent carrying both
 *     `access_type=offline` and `prompt=consent`. A later consent without
 *     `prompt=consent` returns an access token and no refresh token, and the
 *     connector silently stops working unattended.
 *   - A refresh response omits `refresh_token` entirely. Overwriting the stored
 *     one with `undefined` is the other way this breaks.
 *   - Tokens are per-connector, so a leaked token reads one product rather than
 *     everything this account can see.
 */
import { randomBytes, createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One Desktop OAuth client serves every Google connector in a workspace; each
 * connector still gets its own grant and token file. GOOGLE_OAUTH_CLIENT_FILE
 * overrides the location (relative paths resolve from the workspace root).
 */
export function defaultClientPath() {
  const configured = process.env.GOOGLE_OAUTH_CLIENT_FILE;
  if (!configured) return join(WORKSPACE_ROOT, 'data', 'google', 'oauth-client.json');
  return configured.startsWith('/') ? configured : join(WORKSPACE_ROOT, configured);
}

export const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/* ------------------------------------------------------------------ PKCE -- */

export function createPkcePair() {
  const verifier = randomBytes(64).toString('base64url'); // 86 chars, within 43-128
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createState() {
  return randomBytes(16).toString('hex');
}

export function buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge, scopes }) {
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    // No include_granted_scopes: every Google connector shares one OAuth client,
    // and merging earlier grants would hand a read-only connector's token the
    // read/write scopes of the others.
  })}`;
}

/* ----------------------------------------------------------- credentials -- */

/** Reads the OAuth client JSON exactly as Google hands it over. */
export function loadClientCredentials(credPath = defaultClientPath()) {
  if (!existsSync(credPath)) {
    throw new Error(
      `No OAuth client at ${credPath}.\n`
      + 'Download it from Google Cloud Console → APIs & Services → Credentials →\n'
      + 'your "Desktop app" OAuth client → Download JSON, and save it there.'
    );
  }
  const raw = JSON.parse(readFileSync(credPath, 'utf8'));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) {
    throw new Error(`${credPath} has no client_id/client_secret — is it an OAuth client file?`);
  }
  return { clientId: c.client_id, clientSecret: c.client_secret, projectId: c.project_id ?? null };
}

/* ----------------------------------------------------------- token store -- */

export function readTokens(tokenPath) {
  if (!existsSync(tokenPath)) return null;
  try {
    return JSON.parse(readFileSync(tokenPath, 'utf8'));
  } catch (err) {
    throw new Error(`Token store at ${tokenPath} is unreadable: ${err.message}`);
  }
}

/** Atomic write — a torn write costs a full re-authorization. */
export function writeTokens(tokenPath, tokens) {
  mkdirSync(dirname(tokenPath), { recursive: true });
  const tmp = `${tokenPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  renameSync(tmp, tokenPath);
  return tokens;
}

export function isExpired(tokens, skewSeconds = 120) {
  if (!tokens?.expiresAt) return true;
  return Date.parse(tokens.expiresAt) - skewSeconds * 1000 <= Date.now();
}

function shape(body, previous = null, scopes = []) {
  return {
    accessToken: body.access_token,
    // Google omits refresh_token on every grant after the first.
    refreshToken: body.refresh_token ?? previous?.refreshToken ?? null,
    scope: body.scope ?? previous?.scope ?? scopes.join(' '),
    tokenType: body.token_type ?? 'Bearer',
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
    obtainedAt: new Date().toISOString(),
  };
}

async function postToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google token request failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  }
  return body;
}

export async function exchangeCode({
  clientId, clientSecret, code, redirectUri, codeVerifier, tokenPath, scopes = [],
}) {
  const body = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  if (!body.refresh_token) {
    throw new Error(
      'Google returned no refresh token. The connector cannot run unattended without one.\n'
      + 'This happens when the client was already approved and the consent screen was skipped.\n'
      + 'Revoke access at https://myaccount.google.com/permissions and authorize again.'
    );
  }
  return writeTokens(tokenPath, shape(body, null, scopes));
}

export async function refreshTokens({ clientId, clientSecret, tokenPath }, loaded = null) {
  const tokens = loaded ?? readTokens(tokenPath);
  if (!tokens?.refreshToken) {
    throw new Error(`No refresh token stored at ${tokenPath}. Re-run the connector's authorize.js`);
  }
  const body = await postToken({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return writeTokens(tokenPath, shape(body, tokens));
}

/** Which Google account a token belongs to — useful when a property is missing. */
export async function whoami(accessToken) {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  return res.json();
}

/* --------------------------------------------------- per-connector auth -- */

/**
 * The auth surface one connector needs, bound to its scopes and token file
 * (`data/<name>/tokens.json`). Separate tokens per connector, shared client.
 */
export function googleAuth({ name, scopes }) {
  const tokenPath = join(WORKSPACE_ROOT, 'data', name, 'tokens.json');
  return {
    SCOPES: scopes,
    TOKEN_PATH: tokenPath,
    loadClientCredentials: (path) => loadClientCredentials(path ?? defaultClientPath()),
    buildAuthorizeUrl: (opts) => buildAuthorizeUrl({ ...opts, scopes }),
    readTokens: () => readTokens(tokenPath),
    writeTokens: (tokens) => writeTokens(tokenPath, tokens),
    exchangeCode: (opts) => exchangeCode({ ...opts, tokenPath, scopes }),
    refreshTokens: (creds, loaded = null) => refreshTokens({ ...creds, tokenPath }, loaded),
    isExpired,
    whoami,
  };
}

/**
 * A fresh access token for a connector, refreshing when it is near expiry.
 * Clients call this per request; it reads the token file once and caches.
 */
export function tokenProvider(auth, { reauthHint, log = () => {} } = {}) {
  let credentials = null;
  let tokens = null;
  return {
    async get({ force = false } = {}) {
      credentials ??= auth.loadClientCredentials();
      tokens ??= auth.readTokens();
      if (!tokens) throw new Error(`Not connected. Run: ${reauthHint}`);
      if (force || isExpired(tokens)) {
        log('🔄 Refreshing Google access token…');
        tokens = await auth.refreshTokens(credentials, tokens);
      }
      return tokens.accessToken;
    },
  };
}
