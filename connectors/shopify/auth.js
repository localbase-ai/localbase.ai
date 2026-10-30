/**
 * Shopify auth — two ways in, one access token out.
 *
 *   SHOPIFY_ACCESS_TOKEN                      a custom app's Admin API token (shpat_…),
 *                                             created in the store admin. Never expires.
 *   SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET an app from the Shopify Dev Dashboard,
 *                                             installed on your own store. Exchanged for a
 *                                             short-lived token with the client credentials
 *                                             grant, cached in data/shopify/tokens.json.
 *
 * Shopify stopped letting merchants create new custom apps in the store admin in
 * early 2026, so new setups use the second path. A token that already exists
 * keeps working, so the first path stays.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TOKEN_PATH = join(WORKSPACE_ROOT, 'data', 'shopify', 'tokens.json');

/** Read-only; read_all_orders lifts the 60-day order window (see README). */
export const SCOPES = ['read_orders', 'read_all_orders', 'read_products', 'read_inventory'];

/** "my-store", "my-store.myshopify.com" or a full URL → "my-store.myshopify.com". */
export function normaliseShopDomain(value) {
  if (!value) throw new Error('SHOPIFY_STORE_DOMAIN is not set (e.g. my-store.myshopify.com).');
  const host = String(value).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  // Anchored: the client secret is posted to this host, so "evil.com#.myshopify.com" must not pass.
  if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) return host;
  if (/^[a-z0-9][a-z0-9-]*$/.test(host)) return `${host}.myshopify.com`;
  throw new Error(
    `SHOPIFY_STORE_DOMAIN must be the store's myshopify.com domain, not "${host}". `
    + 'Find it in Settings → Domains.'
  );
}

export function readTokens(path = TOKEN_PATH) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Token store at ${path} is unreadable: ${err.message}`);
  }
}

/** Atomic and owner-only. */
export function writeTokens(tokens, path = TOKEN_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  return tokens;
}

export function isExpired(tokens, skewSeconds = 300) {
  if (!tokens?.accessToken) return true;
  if (!tokens.expiresAt) return false;
  return Date.parse(tokens.expiresAt) - skewSeconds * 1000 <= Date.now();
}

/** Client credentials grant against the store's own token endpoint. */
export async function requestClientCredentialsToken({ shop, clientId, clientSecret, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Shopify token request failed: ${body.error_description || body.error || `HTTP ${res.status}`}. `
      + 'Check the app is installed on this store and the client ID/secret belong to it.'
    );
  }
  return {
    shop,
    accessToken: body.access_token,
    scope: body.scope ?? null,
    expiresAt: body.expires_in
      ? new Date(Date.now() + body.expires_in * 1000).toISOString()
      : null,
    obtainedAt: new Date().toISOString(),
  };
}

/**
 * Returns a function that yields a valid access token, refreshing a cached
 * client-credentials token when it nears expiry.
 */
export function tokenProvider(env = process.env, { fetchImpl = fetch, tokenPath = TOKEN_PATH } = {}) {
  const shop = normaliseShopDomain(env.SHOPIFY_STORE_DOMAIN);
  if (env.SHOPIFY_ACCESS_TOKEN) {
    const token = env.SHOPIFY_ACCESS_TOKEN.trim();
    return { shop, mode: 'access-token', get: async () => token };
  }
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new Error(
      'No Shopify credentials. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (Dev Dashboard app), '
      + 'or SHOPIFY_ACCESS_TOKEN (admin-created custom app), in env.local.'
    );
  }
  let cached = null;
  return {
    shop,
    mode: 'client-credentials',
    async get({ force = false } = {}) {
      cached ??= readTokens(tokenPath);
      if (cached && cached.shop !== shop) cached = null; // store changed in env.local
      if (force || isExpired(cached)) {
        cached = writeTokens(await requestClientCredentialsToken({
          shop, clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET, fetchImpl,
        }), tokenPath);
      }
      return cached.accessToken;
    },
  };
}
