/**
 * Search Console API client.
 *
 * Deliberately dependency-free: the whole surface this connector needs is two
 * endpoints, so pulling in `googleapis` (tens of MB, the entire Google API
 * surface) to reach them would be a poor trade.
 *
 * Quota shape is different from a leaky bucket — Search Console enforces
 * per-minute and per-day caps per site and per project, and answers a breach
 * with HTTP 429. There is no budget header to pace against, so the client backs
 * off exponentially on 429/5xx and keeps concurrency at one.
 */
import { readTokens, refreshTokens, isExpired, loadClientCredentials } from './auth.js';

export const API_BASE = 'https://www.googleapis.com/webmasters/v3';

/** searchAnalytics.query caps a single response at 25,000 rows. */
export const MAX_ROW_LIMIT = 25000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SearchConsoleClient {
  constructor({ credentialsPath = null, verbose = false } = {}) {
    this.credentials = loadClientCredentials(credentialsPath);
    this.verbose = verbose;
    this.tokens = null;
  }

  log(...args) {
    if (this.verbose) console.log(...args);
  }

  async accessToken() {
    let tokens = this.tokens ?? readTokens();
    if (!tokens) {
      throw new Error('Not connected. Run: node connectors/google-search-console/authorize.js');
    }
    if (isExpired(tokens)) {
      this.log('🔄 Access token expired, refreshing…');
      tokens = await refreshTokens(this.credentials, tokens);
    }
    this.tokens = tokens;
    return tokens.accessToken;
  }

  /**
   * One API call, with retries. 401 is retried once after a forced refresh:
   * a token can be revoked server-side before its stated expiry.
   */
  async request(path, { method = 'GET', body = null, retries = 5 } = {}) {
    let attempt = 0;
    let refreshed = false;

    for (;;) {
      const token = await this.accessToken();
      const res = await fetch(`${API_BASE}${path}`, {
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
        // Search Console publishes no Retry-After, so back off exponentially.
        const waitMs = Math.min(2 ** attempt * 1000, 32000) + Math.floor(Math.random() * 400);
        attempt += 1;
        this.log(`⏳ HTTP ${res.status} — retry ${attempt}/${retries} in ${(waitMs / 1000).toFixed(1)}s`);
        await sleep(waitMs);
        continue;
      }

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = payload.error ?? {};
        const detail = err.message ?? `HTTP ${res.status}`;
        const reason = err.errors?.[0]?.reason ? ` (${err.errors[0].reason})` : '';
        throw new Error(`Search Console API error: ${detail}${reason}`);
      }
      return payload;
    }
  }

  /** Every property the authorized account can see, with its permission level. */
  async listSites() {
    const body = await this.request('/sites');
    return body.siteEntry ?? [];
  }

  /**
   * searchAnalytics.query for one site, paged to exhaustion.
   *
   * Google "does not guarantee to return all data rows but rather top ones", so
   * a short page is the only end-of-data signal available — there is no total
   * count and no next-page token. Paging stops when a page comes back smaller
   * than the row limit.
   */
  async *queryAll(siteUrl, request, { rowLimit = MAX_ROW_LIMIT, costKey = '' } = {}) {
    let startRow = 0;
    for (;;) {
      const page = await this.request(
        `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        { method: 'POST', body: { ...request, rowLimit, startRow } }
      );
      const rows = page.rows ?? [];
      if (rows.length) {
        this.log(`   ${costKey} rows ${startRow}–${startRow + rows.length - 1}`);
        yield { rows, metadata: page.metadata ?? null };
      }
      if (rows.length < rowLimit) return;
      startRow += rows.length;
    }
  }
}
