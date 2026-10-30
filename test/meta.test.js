/**
 * Meta connector tests. All offline — fixtures shaped like Graph responses,
 * and a fake fetch for the client.
 *
 * What is worth guarding: that spend lands in the right columns and actions
 * are not double-counted, that a retired organic metric costs only itself,
 * that throttling headers actually slow the client down, and that nothing
 * syncs without an allowlist.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';

import {
  LEVELS, HEADLINE_ACTIONS, insightDdl, insightTable, insightToRow, actionRows, ACTIONS_DDL,
  OBJECTS_DDL, OBJECT_TABLE, objectToRow, ORGANIC_DDL, STATE_DDL, seriesRows, totalValueRows,
  lifetimeRows, postToRow, mediaToRow, normaliseAdAccountId, resolveTargets, chunkWindow,
  endTimeToDate, metricValue, excerpt, parseIgMetrics, DEFAULT_IG_METRICS, REVISION_DAYS,
  monthsAgo, EXCERPT_LENGTH,
} from '../connectors/meta/reports.js';
import {
  MetaClient, usageFromHeaders, paceDelay, isRetryable, DEFAULT_API_VERSION, THROTTLE_AT,
} from '../connectors/meta/client.js';
import { MetaConnector } from '../connectors/meta/index.js';

const insightFixture = {
  account_id: '111', campaign_id: 'c1', campaign_name: 'Calls', adset_id: 's1', adset_name: 'Metro',
  ad_id: 'a1', ad_name: 'Video', date_start: '2026-10-01', date_stop: '2026-10-01',
  spend: '12.34', impressions: '1000', reach: '800', clicks: '40', inline_link_clicks: '25',
  ctr: '4', cpc: '0.31', cpm: '12.34', frequency: '1.25',
  actions: [
    { action_type: 'link_click', value: '25' },
    { action_type: 'lead', value: '2' },
    { action_type: 'click_to_call_native_call_placed', value: '3' },
  ],
  action_values: [{ action_type: 'lead', value: '100' }],
  cost_per_action_type: [{ action_type: 'lead', value: '6.17' }],
};

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function assertFits(db, table, row) {
  const cols = columnsOf(db, table);
  for (const key of Object.keys(row)) {
    assert.ok(cols.has(key), `row emits "${key}" but ${table} has no such column`);
  }
}

describe('Meta ids and allowlists', () => {
  it('normalises ad account ids with or without act_', () => {
    assert.strictEqual(normaliseAdAccountId('act_123'), '123');
    assert.strictEqual(normaliseAdAccountId(' 123 '), '123');
    assert.strictEqual(normaliseAdAccountId(123), '123');
  });

  it('syncs only allowlisted assets and reports the rest', () => {
    const visible = [{ id: 'act_1', name: 'Ours' }, { id: 'act_2', name: 'Someone else' }];
    const r = resolveTargets(['1', 'act_9'], visible, normaliseAdAccountId);
    assert.deepStrictEqual(r.targets.map((a) => a.id), ['act_1']);
    assert.deepStrictEqual(r.excluded.map((a) => a.id), ['act_2']);
    assert.deepStrictEqual(r.missing, ['9']);
  });

  it('an empty allowlist selects nothing', () => {
    const r = resolveTargets([], [{ id: '1' }]);
    assert.strictEqual(r.targets.length, 0);
  });
});

describe('Meta ads rows', () => {
  it('maps spend, delivery and headline actions', () => {
    const row = insightToRow('campaign', insightFixture, { fetchedAt: 't' });
    assert.strictEqual(row.account_id, '111');
    assert.strictEqual(row.date, '2026-10-01');
    assert.strictEqual(row.spend, 12.34);
    assert.strictEqual(row.leads, 2);
    assert.strictEqual(row.calls_placed, 3);
    assert.strictEqual(row.link_click_actions, 25);
    assert.strictEqual(row.messaging_starts, 0, 'absent actions are 0, not null, so SUM works');
    assert.strictEqual(row.attribution_setting, 'account default');
    assert.ok(!('adset_id' in row), 'campaign rows carry no ad set columns');
  });

  it('every level row fits its table and is keyed on account, date and object', () => {
    const db = new Database(':memory:');
    for (const level of LEVELS) {
      db.exec(insightDdl(level));
      const row = insightToRow(level, insightFixture, { fetchedAt: 't' });
      assertFits(db, insightTable(level), row);
      const pk = db.prepare(`PRAGMA table_info(${insightTable(level)})`).all().filter((c) => c.pk).map((c) => c.name);
      assert.deepStrictEqual(pk.sort(), ['account_id', 'date', `${level}_id`].sort());
      assert.ok(row[`${level}_id`], `${level} id mapped`);
    }
    db.close();
  });

  it('headline action columns are unique', () => {
    const cols = Object.values(HEADLINE_ACTIONS);
    assert.strictEqual(new Set(cols).size, cols.length);
  });

  it('merges counts, values and costs into one row per action type', () => {
    const rows = actionRows('ad', insightFixture, { fetchedAt: 't' });
    assert.strictEqual(rows.length, 3);
    const lead = rows.find((r) => r.action_type === 'lead');
    assert.strictEqual(lead.value, 2);
    assert.strictEqual(lead.action_value, 100);
    assert.strictEqual(lead.cost_per_action, 6.17);
    assert.strictEqual(lead.object_id, 'a1');
    const db = new Database(':memory:');
    db.exec(ACTIONS_DDL);
    for (const r of rows) assertFits(db, 'meta_actions_daily', r);
    db.close();
  });

  it('re-pulling a restated day updates rather than duplicates', () => {
    const db = new Database(':memory:');
    db.exec(insightDdl('campaign'));
    const table = insightTable('campaign');
    const run = (spend) => {
      const row = insightToRow('campaign', { ...insightFixture, spend: String(spend) }, { fetchedAt: 't' });
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})
        ON CONFLICT(account_id, date, campaign_id) DO UPDATE SET spend = excluded.spend`).run(row);
    };
    run(10);
    run(11.5);
    const rows = db.prepare(`SELECT spend FROM ${table}`).all();
    assert.deepStrictEqual(rows, [{ spend: 11.5 }]);
    db.close();
  });

  it('object rows fit their tables and keep budgets in minor units', () => {
    const db = new Database(':memory:');
    db.exec(OBJECTS_DDL);
    const o = {
      id: 'x', name: 'n', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS',
      daily_budget: '2000', campaign_id: 'c', adset_id: 's', optimization_goal: 'LEAD_GENERATION',
      created_time: '2026-01-01T00:00:00-0500',
    };
    for (const level of LEVELS) {
      const row = objectToRow(level, o, { accountId: 'act_1', fetchedAt: 't' });
      assertFits(db, OBJECT_TABLE[level], row);
      assert.strictEqual(row.account_id, '1');
    }
    assert.strictEqual(objectToRow('campaign', o, { accountId: '1', fetchedAt: 't' }).daily_budget_minor, 2000);
    db.close();
  });
});

describe('Meta organic rows', () => {
  it('dates a daily value by the day it describes, not its end_time', () => {
    assert.strictEqual(endTimeToDate('2026-01-02T08:00:00+0000'), '2026-01-01');
    assert.strictEqual(endTimeToDate('2026-03-09T07:00:00+0000'), '2026-03-08');
    assert.strictEqual(endTimeToDate(null), null);
  });

  it('sums object-valued metrics and keeps the detail', () => {
    assert.deepStrictEqual(metricValue({ like: 3, love: 2 }), { value: 5, detail: '{"like":3,"love":2}' });
    assert.deepStrictEqual(metricValue('7'), { value: 7, detail: null });
    assert.deepStrictEqual(metricValue(null), { value: null, detail: null });
  });

  it('maps Page and IG series, IG total_value, and lifetime insights onto real columns', () => {
    const db = new Database(':memory:');
    db.exec(ORGANIC_DDL);
    db.exec(STATE_DDL);
    const series = [{ name: 'page_media_view', period: 'day', values: [
      { value: 10, end_time: '2026-10-02T07:00:00+0000' },
      { value: 12, end_time: '2026-10-03T07:00:00+0000' },
    ] }];
    const pageRows = seriesRows(series, { idColumn: 'page_id', id: 'p', fetchedAt: 't' });
    assert.deepStrictEqual(pageRows.map((r) => r.date), ['2026-10-01', '2026-10-02']);
    pageRows.forEach((r) => assertFits(db, 'meta_page_daily', r));

    const igRows = totalValueRows([{ name: 'views', period: 'day', total_value: { value: 42 } }],
      { id: 'ig', date: '2026-10-01', fetchedAt: 't' });
    assert.strictEqual(igRows[0].value, 42);
    igRows.forEach((r) => assertFits(db, 'meta_ig_daily', r));

    const media = lifetimeRows([
      { name: 'reach', period: 'lifetime', values: [{ value: 90 }] },
      { name: 'views', total_value: { value: 120 } },
    ], { idColumn: 'media_id', id: 'm', fetchedAt: 't' });
    assert.deepStrictEqual(media.map((r) => r.value), [90, 120]);
    media.forEach((r) => assertFits(db, 'meta_ig_media_insights', r));

    assertFits(db, 'meta_page_posts', postToRow({ id: 'p_1', message: 'hi' }, { pageId: 'p', fetchedAt: 't' }));
    assertFits(db, 'meta_ig_media', mediaToRow({ id: 'm', caption: 'c' }, { igUserId: 'ig', fetchedAt: 't' }));
    db.close();
  });

  it('keeps only a short excerpt of post text', () => {
    const long = 'word '.repeat(200);
    assert.ok(excerpt(long).length <= EXCERPT_LENGTH);
    assert.strictEqual(excerpt('  a\n b '), 'a b');
    assert.strictEqual(excerpt(undefined), null);
  });

  it('parses IG metric overrides and defaults', () => {
    assert.strictEqual(parseIgMetrics(''), DEFAULT_IG_METRICS);
    assert.deepStrictEqual(parseIgMetrics('reach:time_series,views'), [
      { name: 'reach', mode: 'time_series' }, { name: 'views', mode: 'total_value' },
    ]);
    assert.ok(!DEFAULT_IG_METRICS.some((m) => m.name === 'impressions'), 'impressions is retired');
  });
});

describe('Meta windows', () => {
  it('chunks inclusively with no gaps or overlaps', () => {
    const chunks = chunkWindow('2026-01-01', '2026-03-15', 30);
    assert.strictEqual(chunks[0].since, '2026-01-01');
    assert.strictEqual(chunks.at(-1).until, '2026-03-15');
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = new Date(`${chunks[i - 1].until}T00:00:00Z`);
      prev.setUTCDate(prev.getUTCDate() + 1);
      assert.strictEqual(chunks[i].since, prev.toISOString().slice(0, 10));
    }
    assert.deepStrictEqual(chunkWindow('2026-01-01', '2026-01-01', 30), [{ since: '2026-01-01', until: '2026-01-01' }]);
  });

  it('re-pulls a restatement window and stays inside retention', () => {
    assert.ok(REVISION_DAYS >= 28, 'Meta restates conversions for up to 28 days');
    assert.strictEqual(monthsAgo(37, new Date('2026-10-23T12:00:00Z')), '2023-09-24');
  });
});

describe('Meta client', () => {
  const json = (body, { status = 200, headers = {} } = {}) => ({
    ok: status < 400, status, headers: new Headers(headers), json: async () => body,
  });

  it('pins an API version', () => {
    assert.match(DEFAULT_API_VERSION, /^v\d+\.0$/);
  });

  it('reads the highest usage across every throttling header', () => {
    const u = usageFromHeaders(new Headers({
      'x-app-usage': JSON.stringify({ call_count: 10, total_cputime: 5, total_time: 3 }),
      'x-business-use-case-usage': JSON.stringify({ 1: [{ type: 'ads_insights', call_count: 82, total_cputime: 4, total_time: 9, estimated_time_to_regain_access: 0 }] }),
    }));
    assert.strictEqual(u.maxPct, 82);
    assert.strictEqual(paceDelay({ maxPct: THROTTLE_AT - 1 }), 0);
    assert.ok(paceDelay({ maxPct: 90 }) > 0);
    assert.strictEqual(usageFromHeaders(new Headers()).maxPct, 0);
  });

  it('classifies throttling codes as retryable and bad requests as not', () => {
    for (const code of [4, 17, 32, 613, 80000, 80004]) assert.ok(isRetryable({ code }), `code ${code}`);
    for (const code of [100, 190, 200]) assert.ok(!isRetryable({ code }), `code ${code}`);
  });

  it('refuses to start without a token', () => {
    assert.throws(() => new MetaClient({ accessToken: '' }), /META_ACCESS_TOKEN/);
  });

  it('only follows paging URLs on the Graph API host', () => {
    const client = new MetaClient({ accessToken: 'T' });
    assert.strictEqual(client.url('https://graph.facebook.com/v21.0/x?after=1'), 'https://graph.facebook.com/v21.0/x?after=1');
    assert.throws(() => client.url('https://evil.example/v21.0/x'), /not the Graph API/);
  });

  it('follows paging.next without adding a second token', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return url.includes('after=x')
        ? json({ data: [{ id: 2 }] })
        : json({ data: [{ id: 1 }], paging: { next: 'https://graph.facebook.com/v23.0/me/adaccounts?access_token=T&after=x' } });
    };
    const client = new MetaClient({ accessToken: 'T', fetchImpl, sleepImpl: async () => {} });
    const all = await client.all('me/adaccounts', { params: { limit: 2 } });
    assert.deepStrictEqual(all.map((a) => a.id), [1, 2]);
    assert.strictEqual(new URL(seen[1]).searchParams.getAll('access_token').length, 1);
  });

  it('retries a throttled call, then succeeds', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls === 1
        ? json({ error: { code: 17, message: 'User request limit reached' } }, { status: 400 })
        : json({ data: [] });
    };
    const client = new MetaClient({ accessToken: 'T', fetchImpl, sleepImpl: async () => {} });
    await client.request('me');
    assert.strictEqual(calls, 2);
  });

  it('does not retry an auth error', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return json({ error: { code: 190, message: 'expired' } }, { status: 400 }); };
    const client = new MetaClient({ accessToken: 'T', fetchImpl, sleepImpl: async () => {} });
    await assert.rejects(client.request('me'), /code 190/);
    assert.strictEqual(calls, 1);
  });

  it('a retired metric costs only itself', async () => {
    const fetchImpl = async (url) => {
      const metric = new URL(url).searchParams.get('metric');
      if (metric.split(',').includes('page_impressions')) {
        return json({ error: { code: 100, message: 'invalid metric' } }, { status: 400 });
      }
      return json({ data: [{ name: metric, values: [{ value: 1, end_time: '2026-10-02T07:00:00+0000' }] }] });
    };
    const client = new MetaClient({ accessToken: 'T', fetchImpl, sleepImpl: async () => {} });
    const { data, failed } = await client.metricsTolerant('p/insights', ['page_media_view', 'page_impressions', 'page_follows']);
    assert.deepStrictEqual(data.map((d) => d.name), ['page_media_view', 'page_follows']);
    assert.deepStrictEqual(failed.map((f) => f.metric), ['page_impressions']);
  });

  it('adds appsecret_proof when an app secret is configured', async () => {
    let seen;
    const fetchImpl = async (url) => { seen = new URL(url); return json({}); };
    const client = new MetaClient({ accessToken: 'T', appSecret: 's', fetchImpl, sleepImpl: async () => {} });
    await client.request('me');
    assert.match(seen.searchParams.get('appsecret_proof'), /^[0-9a-f]{64}$/);
  });

  it('runs an async insights job to completion', async () => {
    const fetchImpl = async (url, opts = {}) => {
      const u = new URL(url);
      if (opts.method === 'POST') return json({ report_run_id: 'run1' });
      if (u.pathname.endsWith('/run1')) return json({ async_status: 'Job Completed', async_percent_completion: 100 });
      if (u.pathname.endsWith('/run1/insights')) return json({ data: [insightFixture] });
      throw new Error(`unexpected ${url}`);
    };
    const client = new MetaClient({ accessToken: 'T', fetchImpl, sleepImpl: async () => {} });
    const rows = await client.insightsAsync('111', { level: 'ad', since: '2025-01-01', until: '2025-12-31', fields: ['spend'] });
    assert.strictEqual(rows.length, 1);
  });
});

describe('Meta MCP connector', () => {
  it('exposes the standard read-only tools', async () => {
    const tools = (await new MetaConnector().getTools()).map((t) => t.name);
    assert.deepStrictEqual(tools, ['meta_query', 'meta_schema', 'meta_sync_status']);
  });
});
