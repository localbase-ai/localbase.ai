/**
 * GA4 client — Admin API for discovery, Data API for reporting.
 *
 * Unlike Search Console, GA4 reports its own quota state on request
 * (`returnPropertyQuota`), so this client paces from what the API says rather
 * than only backing off after a 429. GA4 meters several buckets at once —
 * tokens per day, per hour, and concurrent requests — and the binding one is
 * whichever is closest to exhaustion.
 */
import { readTokens, refreshTokens, isExpired, loadClientCredentials } from './auth.js';

export const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
export const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';

/** runReport caps a response at 250,000 rows however large `limit` is. */
export const MAX_LIMIT = 250000;
/** What this connector actually asks for per page — smaller keeps quota cost down. */
export const PAGE_LIMIT = 50000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AnalyticsClient {
  constructor({ credentialsPath = null, verbose = false } = {}) {
    this.credentials = loadClientCredentials(credentialsPath);
    this.verbose = verbose;
    this.tokens = null;
    this.quota = null;
  }

  log(...args) {
    if (this.verbose) console.log(...args);
  }

  async accessToken() {
    let tokens = this.tokens ?? readTokens();
    if (!tokens) {
      throw new Error('Not connected. Run: node connectors/google-analytics/authorize.js');
    }
    if (isExpired(tokens)) {
      this.log('🔄 Access token expired, refreshing…');
      tokens = await refreshTokens(this.credentials, tokens);
    }
    this.tokens = tokens;
    return tokens.accessToken;
  }

  async request(url, { method = 'GET', body = null, retries = 5 } = {}) {
    let attempt = 0;
    let refreshed = false;

    for (;;) {
      const token = await this.accessToken();
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
        this.tokens = await refreshTokens(this.credentials);
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
        throw new Error(`GA4 API error: ${err.message ?? `HTTP ${res.status}`}${err.status ? ` (${err.status})` : ''}`);
      }
      if (payload.propertyQuota) this.noteQuota(payload.propertyQuota);
      return payload;
    }
  }

  /**
   * Remember the tightest remaining bucket and slow down as it runs low. GA4
   * returns several independent quotas; the one nearest exhaustion is the one
   * that will actually reject the next call.
   */
  noteQuota(q) {
    this.quota = q;
    const buckets = ['tokensPerDay', 'tokensPerHour', 'concurrentRequests',
      'serverErrorsPerProjectPerHour', 'potentiallyThresholdedRequestsPerHour']
      .map((k) => q[k]).filter((b) => b && typeof b.remaining === 'number');
    if (!buckets.length) return;
    const tightest = buckets.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    this.log(`   quota: ${tightest.remaining} left of ${tightest.consumed + tightest.remaining}`);
  }

  /** Accounts and their GA4 properties, in one call. */
  async listPropertySummaries() {
    const out = [];
    let pageToken = null;
    do {
      const url = new URL(`${ADMIN_API}/accountSummaries`);
      url.searchParams.set('pageSize', '200');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = await this.request(url.toString());
      for (const account of body.accountSummaries ?? []) {
        for (const p of account.propertySummaries ?? []) {
          out.push({
            property: p.property,                     // "properties/123456"
            propertyId: (p.property ?? '').split('/')[1] ?? null,
            displayName: p.displayName ?? null,
            propertyType: p.propertyType ?? null,
            parent: p.parent ?? null,
            account: account.account ?? null,
            accountName: account.displayName ?? null,
          });
        }
      }
      pageToken = body.nextPageToken ?? null;
    } while (pageToken);
    return out;
  }

  /** Property metadata — creation time, timezone, currency, industry. */
  async getProperty(propertyId) {
    return this.request(`${ADMIN_API}/properties/${propertyId}`);
  }

  /**
   * runReport, paged to exhaustion.
   *
   * `rowCount` is the total matching rows, so unlike Search Console there IS a
   * definite end — page until offset covers it rather than guessing from a
   * short page.
   */
  async *runReportAll(propertyId, request, { limit = PAGE_LIMIT, costKey = '' } = {}) {
    let offset = 0;
    for (;;) {
      const body = await this.request(
        `${DATA_API}/properties/${propertyId}:runReport`,
        { method: 'POST', body: { ...request, limit, offset, returnPropertyQuota: true } }
      );
      const rows = body.rows ?? [];
      if (rows.length) {
        this.log(`   ${costKey} rows ${offset}–${offset + rows.length - 1} of ${body.rowCount ?? '?'}`);
        yield {
          rows,
          dimensionHeaders: (body.dimensionHeaders ?? []).map((h) => h.name),
          metricHeaders: (body.metricHeaders ?? []).map((h) => h.name),
          rowCount: body.rowCount ?? rows.length,
        };
      }
      offset += rows.length;
      if (!rows.length || offset >= (body.rowCount ?? 0)) return;
    }
  }
}
