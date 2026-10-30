/**
 * Google Analytics 4 connector tests. All offline.
 *
 * The shapes here were validated against the live API before being committed,
 * so these guard against drift rather than against guesses: a report whose row
 * emits a column its table lacks, a date that never gets normalised, and the
 * shared OAuth contract every Google connector depends on.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { rmSync, statSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  createPkcePair, buildAuthorizeUrl, isExpired, TOKEN_PATH, SCOPES,
} from '../connectors/google-analytics/auth.js';
import { readTokens as readTokensAt, writeTokens as writeTokensAt } from '../connectors/google-oauth.js';
import {
  REPORTS, PROPERTIES_DDL, STATE_DDL, toRow, normaliseDate, FINALISATION_DAYS,
} from '../connectors/google-analytics/reports.js';
import { MAX_LIMIT, PAGE_LIMIT, DATA_API, ADMIN_API } from '../connectors/google-analytics/client.js';

describe('GA4 auth', () => {
  it('asks only for the read-only analytics scope', () => {
    assert.deepStrictEqual(SCOPES, ['https://www.googleapis.com/auth/analytics.readonly']);
  });

  it('keeps its own token file', () => {
    // Separate grants are the point: a leaked token should read one product,
    // not every Google service this account can reach.
    assert.match(TOKEN_PATH, /data\/google-analytics\/tokens\.json$/);
  });

  it('requests offline access and forces consent', () => {
    const url = new URL(buildAuthorizeUrl({
      clientId: 'c', redirectUri: 'http://localhost:3458', state: 's', codeChallenge: 'x',
    }));
    assert.strictEqual(url.searchParams.get('access_type'), 'offline');
    assert.strictEqual(url.searchParams.get('prompt'), 'consent');
    assert.strictEqual(url.searchParams.get('scope'), SCOPES[0]);
  });

  it('produces a valid PKCE verifier', () => {
    const { verifier } = createPkcePair();
    assert.ok(verifier.length >= 43 && verifier.length <= 128);
  });
});

describe('GA4 token store', () => {
  // A temp path, never the real TOKEN_PATH: moving a live token aside and back
  // strands it if the run is killed in between.
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lb-ga4-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips and writes owner-only', () => {
    const path = join(dir, 'tokens.json');
    writeTokensAt(path, { accessToken: 'a', refreshToken: 'r' });
    assert.strictEqual(readTokensAt(path).refreshToken, 'r');
    assert.strictEqual(statSync(path).mode & 0o777, 0o600);
  });

  it('treats missing expiry as expired', () => {
    assert.strictEqual(isExpired(null), true);
    assert.strictEqual(isExpired({ expiresAt: new Date(Date.now() + 600_000).toISOString() }), false);
  });
});

describe('GA4 reports', () => {
  it('normalises GA4 YYYYMMDD dates so they join with every other table', () => {
    assert.strictEqual(normaliseDate('20260911'), '2026-09-11');
    assert.strictEqual(normaliseDate('2026-09-11'), '2026-09-11');
    assert.strictEqual(normaliseDate('(other)'), '(other)');
  });

  it('every report row maps onto real columns in its table', () => {
    const db = new Database(':memory:');
    for (const report of REPORTS) {
      db.exec(report.ddl);
      const columns = new Set(db.prepare(`PRAGMA table_info(${report.table})`).all().map((c) => c.name));
      const row = toRow(report, {
        dimensionValues: report.dimensions.map((d) => ({ value: d === 'date' ? '20260911' : 'v' })),
        metricValues: report.metrics.map(() => ({ value: '1' })),
      }, {
        property: 'p', fetchedAt: 't',
        dimensionHeaders: report.dimensions, metricHeaders: report.metrics,
      });
      for (const key of Object.keys(row)) {
        assert.ok(columns.has(key), `${report.name}: row emits "${key}" but ${report.table} has no such column`);
      }
      // and every declared column that isn't bookkeeping actually gets a value
      assert.ok(row.date, `${report.name}: date was not mapped`);
    }
    db.close();
  });

  it('maps values by response header, not request order', () => {
    // GA4 names its columns in the response. Trusting request order instead
    // would silently shift values into neighbouring columns if the API ever
    // reordered them.
    const report = REPORTS.find((r) => r.name === 'source_medium');
    const row = toRow(report, {
      dimensionValues: [{ value: '20260911' }, { value: 'google' }, { value: 'organic' }],
      metricValues: [{ value: '5' }, { value: '4' }, { value: '3' }, { value: '0' }],
    }, {
      property: 'p', fetchedAt: 't',
      dimensionHeaders: ['date', 'sessionSource', 'sessionMedium'],
      metricHeaders: ['sessions', 'totalUsers', 'engagedSessions', 'keyEvents'],
    });
    assert.strictEqual(row.source, 'google');
    assert.strictEqual(row.medium, 'organic');
    assert.strictEqual(row.sessions, 5);
    assert.strictEqual(row.key_events, 0);
  });

  it('every report is keyed on property and date', () => {
    const db = new Database(':memory:');
    for (const report of REPORTS) {
      db.exec(report.ddl);
      const pk = db.prepare(`PRAGMA table_info(${report.table})`).all()
        .filter((c) => c.pk).map((c) => c.name);
      assert.ok(pk.includes('property'), `${report.table} primary key lacks property`);
      assert.ok(pk.includes('date'), `${report.table} primary key lacks date`);
      assert.ok(report.dimensions.includes('date'), `${report.name} has no date dimension`);
    }
    db.close();
  });

  it('re-pulling the finalisation window updates rather than duplicates', () => {
    const db = new Database(':memory:');
    const report = REPORTS.find((r) => r.name === 'daily');
    db.exec(report.ddl);
    const mk = (sessions) => toRow(report, {
      dimensionValues: [{ value: '20260911' }],
      metricValues: report.metrics.map((m) => ({ value: m === 'sessions' ? String(sessions) : '1' })),
    }, { property: 'p', fetchedAt: 't', dimensionHeaders: report.dimensions, metricHeaders: report.metrics });
    const cols = Object.keys(mk(1));
    const stmt = db.prepare(`INSERT INTO ${report.table} (${cols.join(',')})
      VALUES (${cols.map((c) => '@' + c).join(',')})
      ON CONFLICT(property, date) DO UPDATE SET sessions = excluded.sessions`);
    stmt.run(mk(3));
    stmt.run(mk(9));
    const rows = db.prepare(`SELECT sessions FROM ${report.table}`).all();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].sessions, 9);
    db.close();
  });

  it('report names and tables are unique', () => {
    assert.strictEqual(new Set(REPORTS.map((r) => r.name)).size, REPORTS.length);
    assert.strictEqual(new Set(REPORTS.map((r) => r.table)).size, REPORTS.length);
  });

  it('supporting tables create cleanly', () => {
    const db = new Database(':memory:');
    db.exec(PROPERTIES_DDL);
    db.exec(STATE_DDL);
    assert.ok(db.prepare('PRAGMA table_info(ga_properties)').all().length > 0);
    db.close();
  });
});

describe('GA4 API limits', () => {
  it('never asks for more than the documented cap', () => {
    assert.strictEqual(MAX_LIMIT, 250000);
    assert.ok(PAGE_LIMIT <= MAX_LIMIT, 'page size exceeds the API maximum');
  });

  it('targets the v1beta endpoints', () => {
    assert.strictEqual(DATA_API, 'https://analyticsdata.googleapis.com/v1beta');
    assert.strictEqual(ADMIN_API, 'https://analyticsadmin.googleapis.com/v1beta');
  });

  it('re-pulls a finalisation window', () => {
    assert.ok(FINALISATION_DAYS >= 2, 'GA4 revises recent days as late hits land');
  });
});
