/**
 * Google Search Console connector tests. All offline.
 *
 * These pin what makes the data trustworthy: the scope stays read-only, rows
 * map positionally from the API's unnamed `keys`, every report's table can be
 * created, and the one report that can't be grouped by date is keyed by the
 * window it covers instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';

import { SCOPES } from '../connectors/google-search-console/auth.js';
import {
  REPORTS, toRow, SITES_DDL, STATE_DDL, DEFAULT_SEARCH_TYPES, ALL_SEARCH_TYPES, MAX_LOOKBACK_DAYS,
} from '../connectors/google-search-console/reports.js';
import { GoogleSearchConsoleConnector } from '../connectors/google-search-console/index.js';

const report = (name) => REPORTS.find(r => r.name === name);
const ctx = { site: 'sc-domain:example.com', searchType: 'web', fetchedAt: '2026-01-02T00:00:00Z' };

describe('Search Console auth', () => {
  it('asks for the read-only webmasters scope only', () => {
    assert.deepStrictEqual(SCOPES, ['https://www.googleapis.com/auth/webmasters.readonly']);
  });
});

describe('Search Console reports', () => {
  it('creates every report table plus sites and sync state', () => {
    const db = new Database(':memory:');
    for (const r of REPORTS) db.exec(r.ddl);
    db.exec(SITES_DDL);
    db.exec(STATE_DDL);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
    for (const r of REPORTS) assert.ok(tables.includes(r.table), `${r.table} created`);
  });

  it('puts date on every report except the standalone one', () => {
    for (const r of REPORTS) {
      assert.strictEqual(r.dimensions.includes('date'), !r.standalone, r.name);
    }
  });

  it('maps keys positionally onto the requested dimensions', () => {
    const row = toRow(report('geo_device'),
      { keys: ['2026-01-01', 'usa', 'MOBILE'], clicks: 3, impressions: 40, ctr: 0.075, position: 7.2 }, ctx);
    assert.deepStrictEqual(row, {
      site: ctx.site, search_type: 'web', fetched_at: ctx.fetchedAt,
      date: '2026-01-01', country: 'usa', device: 'MOBILE',
      clicks: 3, impressions: 40, ctr: 0.075, position: 7.2,
    });
  });

  it('defaults missing metrics to zero and a missing position to null', () => {
    const row = toRow(report('daily'), { keys: ['2026-01-01'] }, ctx);
    assert.strictEqual(row.clicks, 0);
    assert.strictEqual(row.impressions, 0);
    assert.strictEqual(row.position, null);
  });

  it('keys the standalone appearance report by the requested window', () => {
    const row = toRow(report('appearance'), { keys: ['VIDEO'], clicks: 1, impressions: 9 },
      { ...ctx, window: { startDate: '2025-12-01', endDate: '2025-12-31' } });
    assert.strictEqual(row.period_start, '2025-12-01');
    assert.strictEqual(row.period_end, '2025-12-31');
    assert.strictEqual(row.search_appearance, 'VIDEO');
    assert.strictEqual(row.date, undefined);
  });

  it('defaults to web search and stays inside the 16-month retention', () => {
    assert.deepStrictEqual(DEFAULT_SEARCH_TYPES, ['web']);
    assert.ok(DEFAULT_SEARCH_TYPES.every(t => ALL_SEARCH_TYPES.includes(t)));
    assert.ok(MAX_LOOKBACK_DAYS <= 16 * 31);
  });
});

describe('Search Console connector', () => {
  it('exposes read-only query, schema and sync-status tools', async () => {
    const tools = await new GoogleSearchConsoleConnector().getTools();
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['gsc_query', 'gsc_schema', 'gsc_sync_status']);
  });
});
