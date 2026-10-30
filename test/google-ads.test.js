/**
 * Google Ads connector tests. All offline.
 *
 * Unlike the GA4 shapes, these queries have not yet run against the live API
 * (no approved developer token was available), so the tests guard the parts
 * that are ours to get right: the mapping from response JSON to columns, the
 * NULL-vs-zero rules, upsert keys, windows, and the error hints.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';

import { SCOPES, TOKEN_PATH } from '../connectors/google-ads/auth.js';
import {
  REPORTS, ddlFor, queryFor, toRow, jsonPath, CUSTOMERS_DDL, GEO_TARGETS_DDL, STATE_DDL,
  REVISION_DAYS,
} from '../connectors/google-ads/reports.js';
import {
  parseAdsError, AdsApiError, normaliseCustomerId, DEFAULT_API_VERSION, AdsClient,
} from '../connectors/google-ads/client.js';
import { windowFor, chunks } from '../connectors/google-ads/sync.js';

/** A fake searchStream result: every field present, in REST camelCase. */
function fakeResult(report, overrides = {}) {
  const out = {};
  for (const field of report.fields) {
    const path = jsonPath(field.field);
    let node = out;
    path.slice(0, -1).forEach((p) => { node[p] ??= {}; node = node[p]; });
    const leaf = path[path.length - 1];
    node[leaf] = overrides[field.column]
      ?? (field.column === 'date' ? '2026-10-01'
        : field.kind === 'text' ? `v-${field.column}`
          : field.kind === 'micros' ? '2500000'
            : field.kind === 'int' || field.kind === 'attr' ? '7' : 0.5);
  }
  return out;
}

describe('Google Ads auth', () => {
  it('uses the adwords scope (the only one Google Ads offers)', () => {
    assert.deepStrictEqual(SCOPES, ['https://www.googleapis.com/auth/adwords']);
  });

  it('keeps its own token file', () => {
    assert.match(TOKEN_PATH, /data\/google-ads\/tokens\.json$/);
  });
});

describe('Google Ads reports', () => {
  it('maps GAQL snake_case fields to REST camelCase paths', () => {
    assert.deepStrictEqual(jsonPath('metrics.cost_micros'), ['metrics', 'costMicros']);
    assert.deepStrictEqual(jsonPath('ad_group_criterion.quality_info.quality_score'),
      ['adGroupCriterion', 'qualityInfo', 'qualityScore']);
    assert.deepStrictEqual(jsonPath('metrics.search_budget_lost_impression_share'),
      ['metrics', 'searchBudgetLostImpressionShare']);
  });

  it('every report row maps onto real columns in its table', () => {
    const db = new Database(':memory:');
    for (const report of REPORTS) {
      db.exec(ddlFor(report));
      const columns = new Set(db.prepare(`PRAGMA table_info(${report.table})`).all().map((c) => c.name));
      const row = toRow(report, fakeResult(report), { customerId: '1', fetchedAt: 't' });
      for (const key of Object.keys(row)) {
        assert.ok(columns.has(key), `${report.name}: row emits "${key}" but ${report.table} has no such column`);
      }
      for (const col of columns) {
        assert.ok(col in row, `${report.name}: column "${col}" is never filled`);
      }
    }
    db.close();
  });

  it('stores money as exact micros and as currency units', () => {
    const report = REPORTS.find((r) => r.name === 'campaign');
    const row = toRow(report, fakeResult(report, { cost: '12345678' }), { customerId: '1', fetchedAt: 't' });
    assert.strictEqual(row.cost_micros, 12345678);
    assert.strictEqual(row.cost, 12.345678);
  });

  it('parses int64 strings as numbers', () => {
    const report = REPORTS.find((r) => r.name === 'campaign');
    const row = toRow(report, fakeResult(report, { clicks: '42' }), { customerId: '1', fetchedAt: 't' });
    assert.strictEqual(row.clicks, 42);
  });

  it('treats an absent metric as zero but absent impression share as NULL', () => {
    // proto3 JSON omits default values: a campaign with no clicks has no
    // `clicks` key at all. Impression share is different — absent means Google
    // did not compute it, and 0 would read as "lost every auction".
    const report = REPORTS.find((r) => r.name === 'campaign');
    const row = toRow(report, {
      segments: { date: '2026-10-01' },
      campaign: { id: '9', name: 'c' },
      metrics: {},
    }, { customerId: '1', fetchedAt: 't' });
    assert.strictEqual(row.clicks, 0);
    assert.strictEqual(row.cost, 0);
    assert.strictEqual(row.search_impression_share, null);
  });

  it('never leaves a NULL in a primary key, so re-pulls upsert instead of duplicating', () => {
    const report = REPORTS.find((r) => r.name === 'geo');
    const db = new Database(':memory:');
    db.exec(ddlFor(report));
    const result = { segments: { date: '2026-10-01' }, campaign: { id: '9' }, geographicView: {}, metrics: { clicks: '1' } };
    const cols = Object.keys(toRow(report, result, { customerId: '1', fetchedAt: 't' }));
    const stmt = db.prepare(`INSERT INTO ${report.table} (${cols.join(',')})
      VALUES (${cols.map((c) => '@' + c).join(',')})
      ON CONFLICT(${report.key.join(',')}) DO UPDATE SET clicks = excluded.clicks`);
    stmt.run(toRow(report, result, { customerId: '1', fetchedAt: 't' }));
    stmt.run(toRow(report, { ...result, metrics: { clicks: '5' } }, { customerId: '1', fetchedAt: 't' }));
    const rows = db.prepare(`SELECT clicks FROM ${report.table}`).all();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].clicks, 5);
    db.close();
  });

  it('keeps only the call id from a call_view resource name', () => {
    const report = REPORTS.find((r) => r.name === 'calls');
    const row = toRow(report, fakeResult(report, { call_id: 'customers/1/callViews/987654' }),
      { customerId: '1', fetchedAt: 't' });
    assert.strictEqual(row.call_id, '987654');
  });

  it('stores no caller phone number', () => {
    const calls = REPORTS.find((r) => r.name === 'calls');
    const fields = calls.fields.map((x) => x.field).join(' ');
    assert.doesNotMatch(fields, /caller_number|phone_number/);
  });

  it('dated reports filter on segments.date, inclusive', () => {
    const q = queryFor(REPORTS.find((r) => r.name === 'campaign'), { startDate: '2026-01-01', endDate: '2026-01-31' });
    assert.match(q, /FROM campaign WHERE segments\.date BETWEEN '2026-01-01' AND '2026-01-31'$/);
  });

  it('call_view filters on call start time, since it has no date segment', () => {
    const q = queryFor(REPORTS.find((r) => r.name === 'calls'), { startDate: '2026-01-01', endDate: '2026-01-31' });
    assert.match(q, /call_view\.start_call_date_time >= '2026-01-01 00:00:00'/);
    assert.match(q, /call_view\.start_call_date_time <= '2026-01-31 23:59:59'/);
    assert.doesNotMatch(q, /segments\.date/);
  });

  it('never mixes conversion-action segments with non-conversion metrics', () => {
    // GAQL rejects segments.conversion_action alongside impressions/clicks/cost.
    for (const report of REPORTS) {
      const fields = report.fields.map((x) => x.field);
      if (!fields.some((x) => x.startsWith('segments.conversion_action'))) continue;
      const bad = fields.filter((x) => /^metrics\.(impressions|clicks|cost_micros|interactions|phone_)/.test(x));
      assert.deepStrictEqual(bad, [], `${report.name} mixes conversion segments with ${bad.join(', ')}`);
    }
  });

  it('metadata reports have no date filter', () => {
    for (const report of REPORTS.filter((r) => !r.dated)) {
      assert.doesNotMatch(queryFor(report), /WHERE/);
    }
  });

  it('report names and tables are unique, and every table keys on customer_id', () => {
    assert.strictEqual(new Set(REPORTS.map((r) => r.name)).size, REPORTS.length);
    assert.strictEqual(new Set(REPORTS.map((r) => r.table)).size, REPORTS.length);
    for (const r of REPORTS) assert.strictEqual(r.key[0], 'customer_id', `${r.table} key`);
  });

  it('supporting tables create cleanly', () => {
    const db = new Database(':memory:');
    db.exec(CUSTOMERS_DDL);
    db.exec(GEO_TARGETS_DDL);
    db.exec(STATE_DDL);
    db.close();
  });
});

describe('Google Ads sync windows', () => {
  it('first and full runs start at the floor', () => {
    assert.deepStrictEqual(windowFor(null, { full: false, today: '2026-10-23', floor: '2024-01-01' }),
      { startDate: '2024-01-01', endDate: '2026-10-23' });
    assert.deepStrictEqual(windowFor('2026-10-20', { full: true, today: '2026-10-23', floor: '2024-01-01' }),
      { startDate: '2024-01-01', endDate: '2026-10-23' });
  });

  it('incremental runs re-pull the revision window', () => {
    assert.ok(REVISION_DAYS >= 14, 'conversions are restated for weeks');
    const w = windowFor('2026-10-20', { full: false, today: '2026-10-23', floor: '2024-01-01', revisionDays: 30 });
    assert.deepStrictEqual(w, { startDate: '2026-09-20', endDate: '2026-10-23' });
  });

  it('chunks cover the window exactly, without gaps or overlap', () => {
    const parts = chunks('2026-01-01', '2026-03-15', 30);
    assert.deepStrictEqual(parts, [
      { startDate: '2026-01-01', endDate: '2026-01-30' },
      { startDate: '2026-01-31', endDate: '2026-03-01' },
      { startDate: '2026-03-02', endDate: '2026-03-15' },
    ]);
    assert.deepStrictEqual(chunks('2026-01-01', '2026-01-01', 30), [{ startDate: '2026-01-01', endDate: '2026-01-01' }]);
  });
});

describe('Google Ads client', () => {
  it('normalises customer ids with or without dashes', () => {
    assert.strictEqual(normaliseCustomerId(['123', '456', '7890'].join('-')), '1234567890');
    assert.strictEqual(normaliseCustomerId(' 1234567890 '), '1234567890');
  });

  it('pins an API version', () => {
    assert.match(DEFAULT_API_VERSION, /^v\d+$/);
  });

  it('refuses to start without a developer token', () => {
    assert.throws(() => new AdsClient({ developerToken: '' }), /GOOGLE_ADS_DEVELOPER_TOKEN/);
  });

  const failure = (group, code, status = 'PERMISSION_DENIED') => ({
    error: {
      code: 403,
      message: 'The caller does not have permission',
      status,
      details: [{
        '@type': `type.googleapis.com/google.ads.googleads.${DEFAULT_API_VERSION}.errors.GoogleAdsFailure`,
        errors: [{ errorCode: { [group]: code }, message: `detail for ${code}` }],
        requestId: 'req-1',
      }],
    },
  });

  it('extracts the errorCode from a GoogleAdsFailure', () => {
    const p = parseAdsError(failure('authorizationError', 'USER_PERMISSION_DENIED'), 403);
    assert.deepStrictEqual(p.codes, [{ group: 'authorizationError', code: 'USER_PERMISSION_DENIED' }]);
    assert.strictEqual(p.requestId, 'req-1');
    assert.strictEqual(p.message, 'detail for USER_PERMISSION_DENIED');
  });

  it('reads errors wrapped in a searchStream array too', () => {
    const p = parseAdsError([failure('authorizationError', 'DEVELOPER_TOKEN_NOT_APPROVED')], 403);
    assert.strictEqual(p.codes[0].code, 'DEVELOPER_TOKEN_NOT_APPROVED');
  });

  it('explains a test-only developer token', () => {
    const err = new AdsApiError(parseAdsError(failure('authorizationError', 'DEVELOPER_TOKEN_NOT_APPROVED'), 403));
    assert.match(err.message, /test-only/);
    assert.match(err.message, /Basic access/);
  });

  it('points at the manager header on permission errors', () => {
    const err = new AdsApiError(parseAdsError(failure('authorizationError', 'USER_PERMISSION_DENIED'), 403));
    assert.match(err.message, /GOOGLE_ADS_LOGIN_CUSTOMER_ID/);
  });

  it('retries quota exhaustion but not permission errors', () => {
    const quota = new AdsApiError(parseAdsError(failure('quotaError', 'RESOURCE_EXHAUSTED', 'RESOURCE_EXHAUSTED'), 429));
    const denied = new AdsApiError(parseAdsError(failure('authorizationError', 'USER_PERMISSION_DENIED'), 403));
    assert.strictEqual(quota.retryable, true);
    assert.strictEqual(denied.retryable, false);
  });
});
