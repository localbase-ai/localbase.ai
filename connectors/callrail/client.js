/**
 * CallRail REST v3 client.
 *
 * Auth is a per-user API key sent as `Authorization: Token token="…"`; there is
 * no OAuth and nothing to refresh. Every account-scoped path lives under
 * `/v3/a/{account_id}/`. Lists page at most 250 records; the calls endpoint also
 * offers relative pagination (`relative_pagination=true` → `has_next_page` /
 * `next_page`), which stays fast deep into a large history where offset paging
 * slows down, so this client prefers it and falls back to page/total_pages.
 *
 * CallRail meters requests per hour and per day. A 429 carries Retry-After;
 * honour it rather than guessing.
 */
export const API_BASE = 'https://api.callrail.com/v3';

/** The documented maximum page size. */
export const MAX_PER_PAGE = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CallRailClient {
  constructor({ apiKey, accountId = null, verbose = false, fetchImpl = fetch, sleepImpl = sleep } = {}) {
    if (!apiKey) {
      throw new Error('CALLRAIL_API_KEY is not set. Create one in CallRail (profile → API Keys) and add it to env.local.');
    }
    this.apiKey = apiKey;
    this.accountId = accountId;
    this.verbose = verbose;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
  }

  log(...args) {
    if (this.verbose) console.log(...args);
  }

  url(path, params = {}) {
    const url = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`);
    // A `next_page` URL comes from the response; the API key goes wherever it
    // points, so refuse any host but CallRail's.
    if (url.origin !== new URL(API_BASE).origin) throw new Error(`Refusing to call ${url.origin}: not the CallRail API`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return url.toString();
  }

  accountPath(rest) {
    if (!this.accountId) throw new Error('No CallRail account id set (CALLRAIL_ACCOUNT_ID).');
    return `/a/${encodeURIComponent(this.accountId)}/${rest}`;
  }

  async request(pathOrUrl, params = {}, { retries = 5 } = {}) {
    const url = this.url(pathOrUrl, params);
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.fetch(url, {
        headers: { Authorization: `Token token="${this.apiKey}"`, Accept: 'application/json' },
      });

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 1000, 32000) + Math.floor(Math.random() * 400);
        this.log(`⏳ HTTP ${res.status} — retry ${attempt + 1}/${retries} in ${(waitMs / 1000).toFixed(1)}s`);
        await this.sleep(waitMs);
        continue;
      }

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body.error ?? body.errors ?? body.message ?? `HTTP ${res.status}`;
        const err = new Error(`CallRail API error (${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
        err.status = res.status;
        throw err;
      }
      return body;
    }
  }

  /**
   * Every record of a list endpoint. `key` is the array's name in the body
   * (`calls`, `companies`, …). Relative pagination when the response offers it,
   * otherwise page/total_pages.
   */
  async *paginate(path, key, params = {}, { relative = false } = {}) {
    const base = { per_page: MAX_PER_PAGE, ...params, ...(relative ? { relative_pagination: true } : {}) };
    let next = null;
    let page = 1;
    for (;;) {
      const body = next
        ? await this.request(next)
        : await this.request(path, relative ? base : { ...base, page });
      const records = body[key] ?? [];
      if (records.length) yield records;

      if ('has_next_page' in body || 'next_page' in body) {
        if (!body.has_next_page || !body.next_page) return;
        next = body.next_page;
        continue;
      }
      const totalPages = Number(body.total_pages ?? 1);
      if (!records.length || page >= totalPages) return;
      page += 1;
    }
  }

  async all(path, key, params = {}, opts = {}) {
    const out = [];
    for await (const batch of this.paginate(path, key, params, opts)) out.push(...batch);
    return out;
  }

  /** Accounts this key can see — used when CALLRAIL_ACCOUNT_ID is unset. */
  listAccounts() {
    return this.all('/a.json', 'accounts');
  }

  listCompanies() {
    return this.all(this.accountPath('companies.json'), 'companies');
  }

  listTrackers(companyId) {
    return this.all(this.accountPath('trackers.json'), 'trackers', { company_id: companyId });
  }

  /** Calls for one company in a date window, oldest first. */
  calls(companyId, { startDate, endDate, fields }) {
    return this.paginate(this.accountPath('calls.json'), 'calls', {
      company_id: companyId,
      start_date: startDate,
      end_date: endDate,
      fields,
      sort: 'start_time',
      order: 'asc',
    }, { relative: true });
  }

  formSubmissions(companyId, { startDate, endDate }) {
    return this.paginate(this.accountPath('form_submissions.json'), 'form_submissions', {
      company_id: companyId,
      start_date: startDate,
      end_date: endDate,
    });
  }
}
