/**
 * Meta Graph API client — read-only, one access token, built-in fetch.
 *
 * Meta throttles on several meters at once and reports them in response
 * headers rather than only by rejecting calls: X-App-Usage (per app),
 * X-Business-Use-Case-Usage (per business object, the one the Marketing and
 * Pages APIs actually enforce) and X-Ad-Account-Usage. Each is a percentage of
 * the budget used. This client reads all of them after every call and slows
 * down once the highest passes THROTTLE_AT, rather than waiting to be blocked;
 * a block (codes 4, 17, 32, 613, 80000-series) is retried with backoff, or
 * after the regain time Meta states.
 */
import { createHmac } from 'crypto';

/**
 * Pinned so a Meta release cannot change field semantics under a scheduled
 * sync. Graph versions live ~2 years; bump deliberately and re-check the metric
 * lists in reports.js when you do. Override with META_API_VERSION.
 */
export const DEFAULT_API_VERSION = 'v23.0';
export const GRAPH_HOST = 'https://graph.facebook.com';

/** Usage percentage at which the client starts pacing itself. */
export const THROTTLE_AT = 75;

/** Graph error codes that mean "slow down / try again", not "you asked wrong". */
export function isRetryable(err) {
  const code = err?.code;
  if ([1, 2, 4, 17, 32, 341, 613].includes(code)) return true;
  if (code >= 80000 && code <= 80099) return true;
  return err?.is_transient === true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseJsonHeader(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Highest usage percentage across every throttling header, and the longest
 * regain time Meta states (minutes). Pure, so it can be tested on fixtures.
 */
export function usageFromHeaders(headers) {
  const get = (name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]);
  const pcts = [];
  let regainMinutes = 0;

  const app = parseJsonHeader(get('x-app-usage'));
  if (app) pcts.push(app.call_count, app.total_cputime, app.total_time);

  const buc = parseJsonHeader(get('x-business-use-case-usage'));
  if (buc) {
    for (const entries of Object.values(buc)) {
      for (const e of entries ?? []) {
        pcts.push(e.call_count, e.total_cputime, e.total_time);
        regainMinutes = Math.max(regainMinutes, Number(e.estimated_time_to_regain_access) || 0);
      }
    }
  }

  const acct = parseJsonHeader(get('x-ad-account-usage'));
  if (acct) {
    pcts.push(acct.acc_id_util_pct);
    regainMinutes = Math.max(regainMinutes, Math.ceil((Number(acct.reset_time_duration) || 0) / 60));
  }

  const maxPct = Math.max(0, ...pcts.map(Number).filter((n) => Number.isFinite(n)));
  return { maxPct, regainMinutes };
}

/** Wait (ms) before the next call, given current usage. Linear from THROTTLE_AT to 100%. */
export function paceDelay({ maxPct }) {
  if (maxPct < THROTTLE_AT) return 0;
  return Math.min(60000, Math.round(((maxPct - THROTTLE_AT) / (100 - THROTTLE_AT)) * 60000));
}

export class GraphError extends Error {
  constructor(error, status) {
    super(`Meta API error: ${error?.message ?? `HTTP ${status}`}`
      + (error?.code != null ? ` (code ${error.code}${error.error_subcode ? `/${error.error_subcode}` : ''})` : ''));
    this.code = error?.code;
    this.subcode = error?.error_subcode;
    this.is_transient = error?.is_transient;
    this.status = status;
  }
}

export class MetaClient {
  constructor({
    accessToken = process.env.META_ACCESS_TOKEN,
    appSecret = process.env.META_APP_SECRET,
    version = process.env.META_API_VERSION || DEFAULT_API_VERSION,
    verbose = false,
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = {}) {
    if (!accessToken) {
      throw new Error('META_ACCESS_TOKEN is not set. See connectors/meta/README.md for creating a System User token.');
    }
    this.accessToken = accessToken;
    this.appSecret = appSecret || null;
    this.version = version;
    this.verbose = verbose;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.pageTokens = new Map();
    this.lastUsage = { maxPct: 0, regainMinutes: 0 };
  }

  log(...args) {
    if (this.verbose) console.log(...args);
  }

  url(path) {
    if (!path.startsWith('http')) return `${GRAPH_HOST}/${this.version}/${path.replace(/^\//, '')}`;
    // A `paging.next` URL comes from the response and the access token is added
    // to it, so refuse any host but the Graph API's.
    if (new URL(path).origin !== GRAPH_HOST) throw new Error(`Refusing to call ${new URL(path).origin}: not the Graph API`);
    return path;
  }

  /**
   * appsecret_proof proves the call comes from the app's owner. Optional, but
   * if the app has "Require App Secret" on, every call needs it.
   */
  proof(token) {
    return this.appSecret ? createHmac('sha256', this.appSecret).update(token).digest('hex') : null;
  }

  async request(path, { params = {}, method = 'GET', token = this.accessToken, retries = 5 } = {}) {
    let attempt = 0;
    for (;;) {
      const wait = paceDelay(this.lastUsage);
      if (wait) {
        this.log(`   ⏳ usage ${this.lastUsage.maxPct}% — pausing ${(wait / 1000).toFixed(0)}s`);
        await this.sleep(wait);
      }

      const url = new URL(this.url(path));
      const body = new URLSearchParams();
      const target = method === 'GET' ? url.searchParams : body;
      for (const [k, v] of Object.entries(params)) {
        if (v == null) continue;
        target.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      // A paging `next` URL already carries the token; don't add a second one.
      if (!url.searchParams.has('access_token')) target.set('access_token', token);
      const proof = this.proof(token);
      if (proof && !url.searchParams.has('appsecret_proof')) target.set('appsecret_proof', proof);

      const res = await this.fetch(url.toString(), method === 'GET' ? {} : { method, body });
      this.lastUsage = usageFromHeaders(res.headers);
      const payload = await res.json().catch(() => ({}));

      if (res.ok && !payload.error) return payload;

      const err = new GraphError(payload.error, res.status);
      if ((isRetryable(err) || res.status >= 500) && attempt < retries) {
        attempt += 1;
        const regain = this.lastUsage.regainMinutes * 60000;
        const waitMs = Math.max(regain, Math.min(2 ** attempt * 2000, 120000));
        this.log(`   ⏳ ${err.message} — retry ${attempt}/${retries} in ${(waitMs / 1000).toFixed(0)}s`);
        await this.sleep(waitMs);
        continue;
      }
      throw err;
    }
  }

  /** Every item across `paging.next`. */
  async *paginate(path, opts = {}) {
    let next = path;
    let first = true;
    while (next) {
      const body = await this.request(next, first ? opts : { ...opts, params: {} });
      first = false;
      for (const item of body.data ?? []) yield item;
      next = body.paging?.next ?? null;
    }
  }

  async all(path, opts = {}) {
    const out = [];
    for await (const item of this.paginate(path, opts)) out.push(item);
    return out;
  }

  /* ---------------------------------------------------------- discovery -- */

  listAdAccounts() {
    return this.all('me/adaccounts', {
      params: { fields: 'id,account_id,name,currency,timezone_name,account_status', limit: 200 },
    });
  }

  listPages() {
    return this.all('me/accounts', {
      params: { fields: 'id,name,instagram_business_account', limit: 200 },
    });
  }

  /**
   * Page Insights refuse a user/system-user token; they need the Page's own
   * token, which the system-user token can mint. Held in memory only.
   */
  async pageToken(pageId) {
    if (!this.pageTokens.has(pageId)) {
      const body = await this.request(pageId, { params: { fields: 'access_token' } });
      if (!body.access_token) {
        throw new Error(`No Page access token for ${pageId} — is the Page assigned to this System User with pages_read_engagement?`);
      }
      this.pageTokens.set(pageId, body.access_token);
    }
    return this.pageTokens.get(pageId);
  }

  /* ----------------------------------------------------------- insights -- */

  /** Short windows: a plain paged GET. */
  insightsSync(accountId, { level, since, until, fields }) {
    return this.all(`act_${accountId}/insights`, {
      params: {
        level, fields: fields.join(','), time_increment: 1,
        time_range: { since, until }, limit: 500,
      },
    });
  }

  /**
   * Long windows: an async report job. A synchronous request over a long
   * daily window at ad level times out; the job does not.
   */
  async insightsAsync(accountId, { level, since, until, fields }, { pollMs = 5000, maxPolls = 360 } = {}) {
    const job = await this.request(`act_${accountId}/insights`, {
      method: 'POST',
      params: { level, fields: fields.join(','), time_increment: 1, time_range: { since, until } },
    });
    const runId = job.report_run_id;
    if (!runId) throw new Error('Meta did not return a report_run_id for the async insights job');

    for (let i = 0; i < maxPolls; i += 1) {
      const status = await this.request(runId, { params: { fields: 'async_status,async_percent_completion' } });
      this.log(`   job ${runId}: ${status.async_status} ${status.async_percent_completion ?? 0}%`);
      if (status.async_status === 'Job Completed') {
        return this.all(`${runId}/insights`, { params: { limit: 500 } });
      }
      if (['Job Failed', 'Job Skipped'].includes(status.async_status)) {
        throw new Error(`Async insights job ${runId} ended: ${status.async_status}`);
      }
      await this.sleep(pollMs);
    }
    throw new Error(`Async insights job ${runId} did not finish in time`);
  }

  /* ------------------------------------------------------------ metrics -- */

  /**
   * Fetch several metrics, surviving retired ones. Asks for all of them in one
   * call; if Meta rejects the set as invalid (code 100), asks for each alone so
   * one retired metric costs only itself. Returns { data, failed: [{metric, error}] }.
   */
  async metricsTolerant(path, metrics, { params = {}, token } = {}) {
    if (!metrics.length) return { data: [], failed: [] };
    try {
      const body = await this.request(path, { params: { ...params, metric: metrics.join(',') }, token });
      return { data: body.data ?? [], failed: [] };
    } catch (err) {
      if (err?.code !== 100) throw err;
      if (metrics.length === 1) return { data: [], failed: [{ metric: metrics[0], error: err.message }] };
    }
    const data = [];
    const failed = [];
    for (const metric of metrics) {
      try {
        const body = await this.request(path, { params: { ...params, metric }, token });
        data.push(...(body.data ?? []));
      } catch (err) {
        if (err?.code !== 100) throw err;
        failed.push({ metric, error: err.message });
      }
    }
    return { data, failed };
  }
}
