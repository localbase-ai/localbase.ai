/**
 * Shopify Admin GraphQL client.
 *
 * Shopify meters GraphQL by query cost, not request count: each store has a
 * bucket of points (1,000 on standard plans, more on Plus) that refills at a
 * fixed rate per second, and every response reports what is left in
 * `extensions.cost.throttleStatus`. This client paces from that report — it
 * waits for the bucket to refill before a query that would not fit — rather than
 * firing until the API answers THROTTLED.
 */
import { tokenProvider } from './auth.js';

/**
 * Shopify supports each quarterly version for at least 12 months. Bump this
 * deliberately and re-run the sync; override with SHOPIFY_API_VERSION.
 */
export const DEFAULT_API_VERSION = '2026-01';

/** A single query may not request more than this many points. */
export const MAX_QUERY_COST = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long to wait so `needed` points are available, from a throttleStatus. */
export function waitForCost(throttleStatus, needed) {
  if (!throttleStatus) return 0;
  const { currentlyAvailable, restoreRate } = throttleStatus;
  if (currentlyAvailable >= needed || !restoreRate) return 0;
  return Math.ceil(((needed - currentlyAvailable) / restoreRate) * 1000);
}

export function isThrottled(errors) {
  return (errors ?? []).some((e) => e?.extensions?.code === 'THROTTLED');
}

export class ShopifyClient {
  constructor({ env = process.env, fetchImpl = fetch, verbose = false, tokens = null, sleepImpl = sleep } = {}) {
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.verbose = verbose;
    this.tokens = tokens ?? tokenProvider(env, { fetchImpl });
    this.shop = this.tokens.shop;
    this.version = env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
    this.endpoint = `https://${this.shop}/admin/api/${this.version}/graphql.json`;
    this.throttle = null;
    this.lastCost = 0;
  }

  log(...args) {
    if (this.verbose) console.log(...args);
  }

  async graphql(query, variables = {}, { retries = 6 } = {}) {
    let attempt = 0;
    let refreshed = false;

    for (;;) {
      const wait = waitForCost(this.throttle, this.lastCost);
      if (wait) {
        this.log(`   ⏳ cost bucket low, waiting ${(wait / 1000).toFixed(1)}s`);
        await this.sleep(wait);
      }

      const token = await this.tokens.get();
      const res = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 401 && !refreshed && this.tokens.mode === 'client-credentials') {
        this.log('   🔄 401 — fetching a fresh token');
        await this.tokens.get({ force: true });
        refreshed = true;
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers?.get?.('retry-after'));
        const waitMs = after > 0 ? after * 1000 : Math.min(2 ** attempt * 1000, 32000);
        attempt += 1;
        this.log(`   ⏳ HTTP ${res.status} — retry ${attempt}/${retries} in ${(waitMs / 1000).toFixed(1)}s`);
        await this.sleep(waitMs);
        continue;
      }

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = typeof body.errors === 'string' ? body.errors : JSON.stringify(body.errors ?? body);
        throw new Error(`Shopify API error (HTTP ${res.status}): ${msg}`);
      }

      const cost = body.extensions?.cost;
      if (cost) {
        this.throttle = cost.throttleStatus ?? null;
        this.lastCost = cost.requestedQueryCost ?? this.lastCost;
      }

      if (isThrottled(body.errors) && attempt < retries) {
        attempt += 1;
        const waitMs = Math.max(waitForCost(this.throttle, this.lastCost), 1000);
        this.log(`   ⏳ THROTTLED — retry ${attempt}/${retries} in ${(waitMs / 1000).toFixed(1)}s`);
        await this.sleep(waitMs);
        this.throttle = null; // that wait was the refill; don't wait for it twice
        continue;
      }

      if (body.errors?.length) {
        const msg = body.errors.map((e) => e.message).join('; ');
        if (/access denied|required access|scope/i.test(msg)) {
          throw new Error(`Shopify denied access: ${msg}. Check the app's Admin API scopes (README).`);
        }
        throw new Error(`Shopify GraphQL error: ${msg}`);
      }
      return body.data;
    }
  }

  /**
   * Cursor-paginate a connection. `path` picks it out of `data` (e.g.
   * 'orders'); the query must take `$after` and select `pageInfo`.
   */
  async *paginate(query, variables, path) {
    let after = null;
    for (;;) {
      const data = await this.graphql(query, { ...variables, after });
      const conn = data?.[path];
      const nodes = conn?.nodes ?? [];
      if (nodes.length) yield nodes;
      if (!conn?.pageInfo?.hasNextPage) return;
      after = conn.pageInfo.endCursor;
    }
  }

  /** Store metadata and the scopes this token actually holds. */
  async shopInfo() {
    const data = await this.graphql(`{
      shop { id name myshopifyDomain currencyCode ianaTimezone createdAt plan { displayName } }
      currentAppInstallation { accessScopes { handle } }
    }`);
    return {
      ...data.shop,
      scopes: (data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle),
    };
  }
}
