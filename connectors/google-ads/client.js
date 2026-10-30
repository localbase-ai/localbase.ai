/**
 * Google Ads client — REST, read-only (`searchStream` and
 * `listAccessibleCustomers`).
 *
 * Three headers matter on every call, and two of them are where setups fail:
 *
 *   Authorization      the OAuth token from authorize.js
 *   developer-token    GOOGLE_ADS_DEVELOPER_TOKEN, from a manager account's API
 *                      Center. A new token is test-only: it can read test
 *                      accounts and nothing else until Google approves it for
 *                      Basic access. That error reads DEVELOPER_TOKEN_NOT_APPROVED.
 *   login-customer-id  GOOGLE_ADS_LOGIN_CUSTOMER_ID, the manager account the
 *                      user reaches the client account THROUGH. Omit it when the
 *                      signed-in user has direct access. Wrong or missing gives
 *                      USER_PERMISSION_DENIED.
 *
 * Errors arrive as a GoogleAdsFailure inside `error.details`; the useful part is
 * the errorCode (e.g. `{ authorizationError: 'USER_PERMISSION_DENIED' }`), which
 * this client surfaces with a hint rather than the generic HTTP status.
 */
import * as auth from './auth.js';
import { tokenProvider } from '../google-oauth.js';

/**
 * Google Ads API versions are sunset roughly a year after release, after which
 * every call fails. Pinned here; override with GOOGLE_ADS_API_VERSION.
 */
export const DEFAULT_API_VERSION = 'v22';
export const API_HOST = 'https://googleads.googleapis.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The dashed form the Ads UI shows and the bare ten digits are the same customer. */
export const normaliseCustomerId = (id) => String(id ?? '').replace(/[^0-9]/g, '');

/** What to do about the errors people actually hit. */
const HINTS = {
  DEVELOPER_TOKEN_NOT_APPROVED:
    'The developer token is test-only. It can read test accounts but not real ones until Google '
    + 'approves it for Basic access (manager account → Tools → API Center).',
  DEVELOPER_TOKEN_PROHIBITED:
    'This developer token is not allowed for the OAuth client\'s Cloud project. A token is tied to '
    + 'the first Cloud project that uses it.',
  DEVELOPER_TOKEN_INVALID: 'GOOGLE_ADS_DEVELOPER_TOKEN is wrong — copy it again from API Center.',
  USER_PERMISSION_DENIED:
    'The signed-in user cannot reach this account directly. If access is through a manager account, '
    + 'set GOOGLE_ADS_LOGIN_CUSTOMER_ID to that manager\'s id; otherwise grant the user access.',
  CUSTOMER_NOT_ENABLED: 'The account is cancelled, suspended or not yet set up.',
  NOT_ADS_USER: 'The signed-in Google account has no Google Ads access. Re-run authorize.js as a user who does.',
  OAUTH_TOKEN_REVOKED: 'Access was revoked. Re-run: node connectors/google-ads/authorize.js',
  OAUTH_TOKEN_EXPIRED: 'Token expired and refresh failed. Re-run: node connectors/google-ads/authorize.js',
};

/** Pull the errorCode name(s) out of a GoogleAdsFailure, whatever the wrapper. */
export function parseAdsError(payload, status) {
  const body = Array.isArray(payload) ? payload[0] : payload;
  const err = body?.error ?? {};
  const codes = [];
  const messages = [];
  for (const detail of err.details ?? []) {
    for (const e of detail.errors ?? []) {
      for (const [group, code] of Object.entries(e.errorCode ?? {})) codes.push({ group, code });
      if (e.message) messages.push(e.message);
    }
  }
  const requestId = (err.details ?? []).map((d) => d.requestId).find(Boolean) ?? null;
  return {
    status: err.status ?? `HTTP ${status}`,
    message: messages[0] ?? err.message ?? `HTTP ${status}`,
    codes,
    requestId,
  };
}

export class AdsApiError extends Error {
  constructor(parsed, { version } = {}) {
    const code = parsed.codes[0];
    const hint = code ? HINTS[code.code] : null;
    super(`Google Ads API error: ${parsed.message}`
      + (code ? ` [${code.group}: ${code.code}]` : ` (${parsed.status})`)
      + (hint ? `\n   → ${hint}` : '')
      + (parsed.requestId ? `\n   request id: ${parsed.requestId}` : '')
      + (version && parsed.status === 'UNIMPLEMENTED'
        ? `\n   → ${version} may be sunset. Set GOOGLE_ADS_API_VERSION to a current version.` : ''));
    this.parsed = parsed;
  }

  get retryable() {
    return this.parsed.codes.some((c) => c.code === 'RESOURCE_EXHAUSTED'
      || c.code === 'RESOURCE_TEMPORARILY_EXHAUSTED')
      || this.parsed.status === 'RESOURCE_EXHAUSTED'
      || this.parsed.status === 'UNAVAILABLE'
      || this.parsed.status === 'INTERNAL';
  }
}

export class AdsClient {
  constructor({
    developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    version = process.env.GOOGLE_ADS_API_VERSION || DEFAULT_API_VERSION,
    verbose = false,
  } = {}) {
    if (!developerToken) {
      throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN is not set. It comes from a Google Ads manager account: '
        + 'Tools → API Center. See connectors/google-ads/README.md.');
    }
    this.developerToken = developerToken;
    this.loginCustomerId = normaliseCustomerId(loginCustomerId) || null;
    this.version = version;
    this.verbose = verbose;
    this.tokens = tokenProvider(auth, {
      reauthHint: 'node connectors/google-ads/authorize.js',
      log: (m) => this.log(m),
    });
  }

  log(...args) {
    if (this.verbose) console.log(...args);
  }

  url(path) {
    return `${API_HOST}/${this.version}/${path}`;
  }

  async headers({ force = false, login = true } = {}) {
    return {
      Authorization: `Bearer ${await this.tokens.get({ force })}`,
      'developer-token': this.developerToken,
      'Content-Type': 'application/json',
      ...(login && this.loginCustomerId ? { 'login-customer-id': this.loginCustomerId } : {}),
    };
  }

  async request(path, { method = 'GET', body = null, login = true, retries = 5 } = {}) {
    let attempt = 0;
    let refreshed = false;
    for (;;) {
      const res = await fetch(this.url(path), {
        method,
        headers: await this.headers({ force: false, login }),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      if (res.status === 401 && !refreshed) {
        this.log('🔄 401 — forcing a token refresh');
        await this.tokens.get({ force: true });
        refreshed = true;
        continue;
      }

      const text = await res.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        // A sunset version answers 404 with an HTML page, not JSON.
        if (res.status === 404) {
          throw new Error(`Google Ads API ${this.version} returned 404 — the version is probably sunset. `
            + 'Set GOOGLE_ADS_API_VERSION to a current version (see the Google Ads API release notes).');
        }
        throw new Error(`Google Ads API: HTTP ${res.status}, non-JSON response`);
      }

      const failed = !res.ok || (Array.isArray(payload) && payload.some((b) => b.error));
      if (!failed) return payload;

      const error = new AdsApiError(parseAdsError(payload, res.status), { version: this.version });
      if ((error.retryable || res.status === 429 || res.status >= 500) && attempt < retries) {
        const waitMs = Math.min(2 ** attempt * 2000, 60000) + Math.floor(Math.random() * 500);
        attempt += 1;
        this.log(`⏳ ${error.parsed.status} — retry ${attempt}/${retries} in ${(waitMs / 1000).toFixed(1)}s`);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }

  /** Customer ids the signed-in user can reach directly (no manager header). */
  async listAccessibleCustomers() {
    const body = await this.request('customers:listAccessibleCustomers', { login: false });
    return (body.resourceNames ?? []).map((r) => r.split('/')[1]);
  }

  /** Every result row of a GAQL query. searchStream returns all batches at once. */
  async search(customerId, query) {
    const batches = await this.request(
      `customers/${normaliseCustomerId(customerId)}/googleAds:searchStream`,
      { method: 'POST', body: { query } },
    );
    return (Array.isArray(batches) ? batches : [batches]).flatMap((b) => b.results ?? []);
  }

  /** Name, currency and timezone of one account; null if it cannot be read. */
  async describeCustomer(customerId) {
    try {
      const [row] = await this.search(customerId,
        'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, '
        + 'customer.manager, customer.test_account FROM customer LIMIT 1');
      return row?.customer ?? null;
    } catch {
      return null;
    }
  }

  /** Client accounts under the manager in GOOGLE_ADS_LOGIN_CUSTOMER_ID. */
  async listManagedCustomers() {
    if (!this.loginCustomerId) return [];
    const rows = await this.search(this.loginCustomerId,
      'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, '
      + 'customer_client.status, customer_client.level FROM customer_client');
    return rows.map((r) => r.customerClient).filter(Boolean);
  }
}
