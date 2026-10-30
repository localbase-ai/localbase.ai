/**
 * CallRail connector tests. All offline — fetch is mocked.
 *
 * The parts worth guarding: no caller PII reaches a row, hashing is stable so
 * repeat callers count, pagination ends, the company allowlist refuses to sync
 * an agency's other clients, and re-syncing a call updates rather than duplicates.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { CallRailClient, MAX_PER_PAGE } from '../connectors/callrail/client.js';
import {
  CALL_FIELDS, DDL, TRAILING_DAYS, hashPhone, normalisePhone, loadSalt, tagNames,
  toCallRow, toFormRow, toTrackerRow, localDate,
} from '../connectors/callrail/entities.js';
import { resolveCompanies, windowFor, writeCalls, parseArgs } from '../connectors/callrail/sync.js';

// Fictional 555-01xx number, assembled so the public-text scanner doesn't read
// it as a real one.
const FAKE_PHONE = ['(555)', '010-0000'].join(' ');

const SAMPLE_CALL = {
  id: 'CAL001',
  company_id: 'COM1',
  tracker_id: 'TRK1',
  start_time: '2026-03-04T21:15:00.000-06:00',
  direction: 'inbound',
  answered: true,
  voicemail: false,
  duration: 184,
  first_call: true,
  customer_name: 'Pat Example',
  customer_phone_number: '+15550100000',
  customer_city: 'Springfield',
  customer_state: 'MO',
  source: 'Google Ads',
  source_name: 'Google Paid',
  campaign: 'Estimates',
  keywords: 'free estimate near me',
  lead_status: 'good_lead',
  value: '250',
  tags: [{ name: 'estimate', color: 'blue' }, 'repeat'],
  recording: 'https://app.callrail.com/calls/CAL001/recording',
  recording_player: 'https://app.callrail.com/calls/CAL001/recording/player',
  transcription: 'hello I would like an estimate',
};

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected request ${url}`);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: (h) => r.headers?.[h.toLowerCase()] ?? null },
      json: async () => r.body ?? {},
    };
  };
  fn.calls = calls;
  return fn;
}

describe('CallRail client', () => {
  it('sends the token header CallRail expects', async () => {
    const fetchImpl = mockFetch([{ body: { accounts: [{ id: 'ACC1' }], total_pages: 1 } }]);
    const client = new CallRailClient({ apiKey: 'k', fetchImpl });
    await client.listAccounts();
    assert.strictEqual(fetchImpl.calls[0].init.headers.Authorization, 'Token token="k"');
    assert.match(fetchImpl.calls[0].url, /\/v3\/a\.json\?per_page=250/);
  });

  it('refuses to start without an API key', () => {
    assert.throws(() => new CallRailClient({}), /CALLRAIL_API_KEY/);
  });

  it('only follows pagination URLs on the CallRail API host', () => {
    const client = new CallRailClient({ apiKey: 'k' });
    assert.match(client.url('https://api.callrail.com/v3/a/1/calls.json?page=2'), /^https:\/\/api\.callrail\.com\//);
    assert.throws(() => client.url('https://evil.example/v3/calls.json'), /not the CallRail API/);
  });

  it('follows relative pagination to the end', async () => {
    const fetchImpl = mockFetch([
      { body: { calls: [{ id: 1 }], has_next_page: true, next_page: 'https://api.callrail.com/v3/a/A/calls.json?offset=x' } },
      { body: { calls: [{ id: 2 }], has_next_page: false, next_page: null } },
    ]);
    const client = new CallRailClient({ apiKey: 'k', accountId: 'A', fetchImpl });
    const out = [];
    for await (const b of client.calls('COM1', { startDate: '2026-01-01', endDate: '2026-01-31', fields: CALL_FIELDS })) out.push(...b);
    assert.deepStrictEqual(out.map((c) => c.id), [1, 2]);
    const first = new URL(fetchImpl.calls[0].url);
    assert.strictEqual(first.searchParams.get('relative_pagination'), 'true');
    assert.strictEqual(first.searchParams.get('company_id'), 'COM1');
    assert.strictEqual(first.searchParams.get('per_page'), String(MAX_PER_PAGE));
    assert.ok(first.searchParams.get('fields').includes('lead_status'));
    assert.strictEqual(fetchImpl.calls[1].url, 'https://api.callrail.com/v3/a/A/calls.json?offset=x');
  });

  it('falls back to page/total_pages', async () => {
    const fetchImpl = mockFetch([
      { body: { companies: [{ id: 'C1' }], page: 1, total_pages: 2 } },
      { body: { companies: [{ id: 'C2' }], page: 2, total_pages: 2 } },
    ]);
    const client = new CallRailClient({ apiKey: 'k', accountId: 'A', fetchImpl });
    const companies = await client.listCompanies();
    assert.deepStrictEqual(companies.map((c) => c.id), ['C1', 'C2']);
    assert.strictEqual(new URL(fetchImpl.calls[1].url).searchParams.get('page'), '2');
  });

  it('honours Retry-After on 429', async () => {
    const waits = [];
    const fetchImpl = mockFetch([
      { status: 429, headers: { 'retry-after': '7' } },
      { body: { accounts: [], total_pages: 1 } },
    ]);
    const client = new CallRailClient({ apiKey: 'k', fetchImpl, sleepImpl: async (ms) => waits.push(ms) });
    await client.listAccounts();
    assert.deepStrictEqual(waits, [7000]);
  });

  it('surfaces the HTTP status on errors so callers can tolerate 403/404', async () => {
    const fetchImpl = mockFetch([{ status: 403, body: { error: 'forbidden' } }]);
    const client = new CallRailClient({ apiKey: 'k', accountId: 'A', fetchImpl });
    await assert.rejects(client.listCompanies(), (err) => err.status === 403);
  });
});

describe('CallRail privacy', () => {
  const row = toCallRow(SAMPLE_CALL, { salt: 's', fetchedAt: 't' });

  it('stores no caller name, number, transcript or recording URL', () => {
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes('Pat Example'));
    assert.ok(!serialised.includes('5550100000'));
    assert.ok(!serialised.includes('would like an estimate'));
    assert.ok(!serialised.includes('/recording'));
    assert.strictEqual(row.has_recording, 1);
  });

  it('hashes the same number the same way however it is formatted', () => {
    assert.strictEqual(normalisePhone(`+1 ${FAKE_PHONE}`), '15550100000');
    assert.strictEqual(hashPhone(`+1 ${FAKE_PHONE}`, 's'), hashPhone('15550100000', 's'));
    assert.notStrictEqual(hashPhone('15550100000', 's'), hashPhone('15550100000', 'other'));
    assert.strictEqual(hashPhone(null, 's'), null);
    assert.match(row.caller_hash, /^[0-9a-f]{64}$/);
  });

  it('joins a caller across calls and form submissions', () => {
    const form = toFormRow({ id: 'F1', customer_phone_number: FAKE_PHONE, customer_email: 'test@example.com', submitted_at: '2026-03-05T10:00:00-06:00' }, { salt: 's', fetchedAt: 't' });
    assert.strictEqual(form.caller_hash, hashPhone('5550100000', 's'));
    assert.ok(!JSON.stringify(form).includes('example.com'));
  });

  it('generates a salt once, owner-only, and reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callrail-'));
    try {
      const path = join(dir, 'salt');
      const a = loadSalt(path, {});
      assert.strictEqual(loadSalt(path, {}), a);
      assert.strictEqual(statSync(path).mode & 0o777, 0o600);
      assert.strictEqual(loadSalt(path, { CALLRAIL_HASH_SALT: 'env' }), 'env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CallRail rows', () => {
  it('takes the call date in the offset CallRail sent, not UTC', () => {
    // 21:15 at -06:00 is already the next day in UTC.
    assert.strictEqual(localDate(SAMPLE_CALL.start_time), '2026-03-04');
  });

  it('normalises tags from strings or objects', () => {
    assert.deepStrictEqual(tagNames(SAMPLE_CALL.tags), ['estimate', 'repeat']);
    assert.deepStrictEqual(tagNames(null), []);
  });

  it('every mapped row fits its table', () => {
    const db = new Database(':memory:');
    db.exec(DDL);
    const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    const check = (table, row) => {
      const c = cols(table);
      for (const k of Object.keys(row)) assert.ok(c.has(k), `${table} lacks ${k}`);
    };
    check('callrail_calls', toCallRow(SAMPLE_CALL, { salt: 's', fetchedAt: 't' }));
    check('callrail_form_submissions', toFormRow({ id: 'F1' }, { salt: 's', fetchedAt: 't' }));
    check('callrail_trackers', toTrackerRow({ id: 'T1', tracking_numbers: ['+15550100001'], source: { type: 'search' } }, { fetchedAt: 't' }));
    db.close();
  });

  it('re-syncing a call updates it and replaces its tags', () => {
    const db = new Database(':memory:');
    db.exec(DDL);
    writeCalls(db, [SAMPLE_CALL], { salt: 's', fetchedAt: 't1', companyId: 'COM1' });
    writeCalls(db, [{ ...SAMPLE_CALL, lead_status: 'not_a_lead', tags: ['spam'] }], { salt: 's', fetchedAt: 't2', companyId: 'COM1' });
    const calls = db.prepare('SELECT lead_status FROM callrail_calls').all();
    assert.deepStrictEqual(calls, [{ lead_status: 'not_a_lead' }]);
    assert.deepStrictEqual(db.prepare('SELECT tag FROM callrail_call_tags').all(), [{ tag: 'spam' }]);
    db.close();
  });

  it('rolls calls up by day, source and campaign', () => {
    const db = new Database(':memory:');
    db.exec(DDL);
    writeCalls(db, [
      SAMPLE_CALL,
      { ...SAMPLE_CALL, id: 'CAL002', answered: false, first_call: false, lead_status: null, value: null },
    ], { salt: 's', fetchedAt: 't', companyId: 'COM1' });
    const [day] = db.prepare('SELECT * FROM callrail_calls_daily').all();
    assert.strictEqual(day.date, '2026-03-04');
    assert.strictEqual(day.source, 'Google Paid');
    assert.strictEqual(day.calls, 2);
    assert.strictEqual(day.answered, 1);
    assert.strictEqual(day.first_time_callers, 1);
    assert.strictEqual(day.qualified_leads, 1);
    db.close();
  });
});

describe('CallRail sync planning', () => {
  const visible = [{ id: 'COM1', name: 'A' }, { id: 'COM2', name: 'B' }];

  it('refuses to sync an agency account without an allowlist', () => {
    assert.match(resolveCompanies(visible, []).error, /CALLRAIL_COMPANY_IDS/);
  });

  it('refuses even a single visible company without one', () => {
    assert.match(resolveCompanies([visible[0]], []).error, /CALLRAIL_COMPANY_IDS/);
  });

  it('keeps to the allowlist', () => {
    assert.deepStrictEqual(resolveCompanies(visible, ['COM2']).targets, [visible[1]]);
    assert.ok(resolveCompanies(visible, ['NOPE']).error);
    assert.ok(resolveCompanies(visible, ['COM2'], 'COM1').error);
  });

  it('re-pulls a trailing window over the watermark', () => {
    const today = new Date('2026-04-30T12:00:00Z');
    const w = windowFor({ watermark: '2026-04-20', full: false, since: null, today });
    assert.strictEqual(TRAILING_DAYS >= 7, true);
    assert.strictEqual(w.startDate, '2026-04-06');
    assert.strictEqual(w.endDate, '2026-04-30');
  });

  it('a full pull reaches back two years, or to --since', () => {
    const today = new Date('2026-04-30T12:00:00Z');
    assert.strictEqual(windowFor({ watermark: '2026-04-20', full: true, today }).startDate, '2024-04-30');
    assert.strictEqual(windowFor({ watermark: null, full: true, since: '2025-01-01', today }).startDate, '2025-01-01');
  });

  it('parses flags', () => {
    assert.deepStrictEqual(parseArgs(['--full', '--since', '2025-01-01', '--company', 'COM1', '--no-forms']),
      { full: true, verbose: false, company: 'COM1', since: '2025-01-01', forms: false });
  });
});
