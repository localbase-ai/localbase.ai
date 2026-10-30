/**
 * Merchant API client — accounts, products and reports.
 *
 * This is the Merchant API (merchantapi.googleapis.com), not the Content API for
 * Shopping it replaces; the Content API is being sunset in 2026. Each sub-API is
 * versioned on its own, so versions are pinned per sub-API and overridable from
 * env.local if Google moves one before this file catches up.
 *
 * Before the first call, Google requires the Cloud project behind the OAuth
 * client to be registered with the Merchant Center account (see register.js).
 * Unregistered calls fail with a permission error that does not say so plainly;
 * `explain()` adds the hint.
 */
import * as auth from './auth.js';
import { tokenProvider } from '../google-oauth.js';

export const BASE = 'https://merchantapi.googleapis.com';
export const VERSIONS = {
  accounts: process.env.MERCHANT_ACCOUNTS_API_VERSION ?? 'v1',
  products: process.env.MERCHANT_PRODUCTS_API_VERSION ?? 'v1',
  reports: process.env.MERCHANT_REPORTS_API_VERSION ?? 'v1',
};

/** products.list accepts up to 1000 per page. */
export const PRODUCTS_PAGE_SIZE = 1000;
/** reports.search page size; the API's own default is 1000. */
export const REPORT_PAGE_SIZE = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Turn an opaque permission failure into the step that usually fixes it. */
export function explain(status, message = '') {
  const m = message.toLowerCase();
  if (m.includes('register') || m.includes('developer') || (status === 403 && m.includes('gcp'))) {
    return `${message}\n\nThe Cloud project behind this OAuth client is probably not registered with the `
      + 'Merchant Center account. Run: node connectors/google-merchant-center/register.js --account <id> --email <your email>';
  }
  if (m.includes('has not been used') || m.includes('is disabled')) {
    return `${message}\n\nEnable the Merchant API on the Cloud project: gcloud services enable merchantapi.googleapis.com`;
  }
  if (status === 403) {
    return `${message}\n\nThe signed-in Google account may not be a user on this Merchant Center account.`;
  }
  return message;
}

export class MerchantClient {
  constructor({ verbose = false } = {}) {
    this.verbose = verbose;
    this.tokens = tokenProvider(auth, {
      reauthHint: 'node connectors/google-merchant-center/authorize.js',
      log: (...a) => this.log(...a),
    });
  }

  log(...args) {
    if (this.verbose) console.log(...args);
  }

  async request(path, { method = 'GET', body = null, retries = 5 } = {}) {
    let attempt = 0;
    let refreshed = false;
    const url = path.startsWith('http') ? path : `${BASE}${path}`;

    for (;;) {
      const token = await this.tokens.get({ force: false });
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      if (res.status === 401 && !refreshed) {
        this.log('🔄 401 — forcing a token refresh');
        await this.tokens.get({ force: true });
        refreshed = true;
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const waitMs = Math.min(2 ** attempt * 1000, 32000) + Math.floor(Math.random() * 400);
        attempt += 1;
        this.log(`⏳ HTTP ${res.status} — retry ${attempt}/${retries} in ${(waitMs / 1000).toFixed(1)}s`);
        await sleep(waitMs);
        continue;
      }

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = payload.error ?? {};
        const msg = `Merchant API error: ${err.message ?? `HTTP ${res.status}`}${err.status ? ` (${err.status})` : ''}`;
        const e = new Error(explain(res.status, msg));
        e.status = res.status;
        throw e;
      }
      return payload;
    }
  }

  /** Follow nextPageToken to exhaustion, yielding each page's `key` array. */
  async *paged(path, key, { method = 'GET', body = null, pageSize } = {}) {
    let pageToken = null;
    do {
      let page;
      if (method === 'GET') {
        const url = new URL(`${BASE}${path}`);
        if (pageSize) url.searchParams.set('pageSize', String(pageSize));
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        page = await this.request(url.toString());
      } else {
        page = await this.request(path, {
          method, body: { ...body, ...(pageSize ? { pageSize } : {}), ...(pageToken ? { pageToken } : {}) },
        });
      }
      const items = page[key] ?? [];
      if (items.length) yield items;
      pageToken = page.nextPageToken ?? null;
    } while (pageToken);
  }

  /** Every Merchant Center account the signed-in user can reach. */
  async listAccounts() {
    const out = [];
    for await (const page of this.paged(`/accounts/${VERSIONS.accounts}/accounts`, 'accounts', { pageSize: 250 })) {
      out.push(...page);
    }
    return out.map((a) => ({
      accountId: String(a.accountId ?? (a.name ?? '').split('/')[1] ?? ''),
      accountName: a.accountName ?? null,
      timeZone: a.timeZone?.id ?? null,
      languageCode: a.languageCode ?? null,
      testAccount: a.testAccount ?? false,
    }));
  }

  async getAccount(accountId) {
    return this.request(`/accounts/${VERSIONS.accounts}/accounts/${accountId}`);
  }

  async *listProducts(accountId) {
    yield* this.paged(`/products/${VERSIONS.products}/accounts/${accountId}/products`, 'products',
      { pageSize: PRODUCTS_PAGE_SIZE });
  }

  async listAccountIssues(accountId) {
    const out = [];
    for await (const page of this.paged(`/accounts/${VERSIONS.accounts}/accounts/${accountId}/issues`,
      'accountIssues', { pageSize: 100 })) out.push(...page);
    return out;
  }

  /** Merchant Query Language over a report view, paged. */
  async *search(accountId, query) {
    yield* this.paged(`/reports/${VERSIONS.reports}/accounts/${accountId}/reports:search`, 'results',
      { method: 'POST', body: { query }, pageSize: REPORT_PAGE_SIZE });
  }

  /**
   * Register this Cloud project with a Merchant Center account. A write, and
   * a one-time setup step — only register.js calls it.
   */
  async registerGcp(accountId, developerEmail) {
    return this.request(
      `/accounts/${VERSIONS.accounts}/accounts/${accountId}/developerRegistration:registerGcp`,
      { method: 'POST', body: { developerEmail } }
    );
  }
}
