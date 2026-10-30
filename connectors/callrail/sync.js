#!/usr/bin/env node
/**
 * Sync CallRail into data/callrail/callrail.db.
 *
 *   node connectors/callrail/sync.js                       incremental, allowed companies
 *   node connectors/callrail/sync.js --full                last 2 years
 *   node connectors/callrail/sync.js --full --since 2024-01-01
 *   node connectors/callrail/sync.js --company COM123      one company
 *   node connectors/callrail/sync.js --no-forms            skip form submissions
 *   node connectors/callrail/sync.js --verbose
 *
 * Watermarks live in sync_state, one row per (company, entity).
 */
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdirSync } from 'fs';
import { CallRailClient } from './client.js';
import {
  CALL_FIELDS, DDL, TRAILING_DAYS, DEFAULT_LOOKBACK_YEARS,
  loadSalt, tagNames, toCallRow, toFormRow, toCompanyRow, toTrackerRow,
} from './entities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTANCE_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(INSTANCE_ROOT, 'data', 'callrail');
const DB_PATH = join(DATA_DIR, 'callrail.db');
const SALT_PATH = join(DATA_DIR, 'salt');

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Which companies to sync.
 *
 * An agency CallRail account sees every client company it manages. Syncing all
 * of them would put other businesses' calls in this workspace's database, so an
 * explicit allowlist is required whenever more than one company is visible.
 * A single visible company is unambiguous and needs none.
 */
export function resolveCompanies(visible, allowlist, only = null) {
  // Always required, even when the key sees one company: that one company can
  // still belong to another business.
  if (!allowlist.length) {
    return {
      error: `Set CALLRAIL_COMPANY_IDS in env.local (comma-separated) to the companies that belong to this `
        + `business. This key can see ${visible.length}: ${visible.map((c) => `${c.id} (${c.name})`).join(', ') || 'none'}.`,
    };
  }
  const permitted = visible.filter((c) => allowlist.includes(String(c.id)));
  if (!permitted.length) {
    return { error: `None of the visible companies are in CALLRAIL_COMPANY_IDS (${allowlist.join(', ')}).` };
  }
  const targets = only ? permitted.filter((c) => String(c.id) === only) : permitted;
  if (!targets.length) return { error: `No allowed company matches "${only}".` };
  return { targets };
}

/** The date window to request for one company and entity. */
export function windowFor({ watermark, full, since, today = new Date() }) {
  const end = iso(today);
  const floor = new Date(today);
  floor.setUTCFullYear(floor.getUTCFullYear() - DEFAULT_LOOKBACK_YEARS);
  if (full) return { startDate: since ?? iso(floor), endDate: end };
  if (!watermark) return { startDate: since ?? iso(floor), endDate: end };
  const from = new Date(`${watermark}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - TRAILING_DAYS);
  return { startDate: iso(from), endDate: end };
}

export function parseArgs(argv) {
  const args = { full: false, verbose: false, company: null, since: null, forms: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--company') args.company = argv[++i];
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--no-forms') args.forms = false;
  }
  return args;
}

function openDb() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(DDL);
  return db;
}

export function makeUpsert(db, table, sampleRow, pk = ['id']) {
  const cols = Object.keys(sampleRow);
  const updatable = cols.filter((c) => !pk.includes(c));
  return db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
     ON CONFLICT(${pk.join(', ')}) DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(', ')}`
  );
}

/** Upsert calls and replace each call's tags, so a removed tag disappears too. */
export function writeCalls(db, calls, { salt, fetchedAt, companyId }) {
  // The request filters by company; don't rely on the server honouring it.
  calls = calls.filter((c) => c.company_id == null || String(c.company_id) === String(companyId));
  if (!calls.length) return { count: 0, maxDate: null };
  const rows = calls.map((c) => toCallRow(c, { salt, fetchedAt, companyId }));
  const upsert = makeUpsert(db, 'callrail_calls', rows[0]);
  const clearTags = db.prepare('DELETE FROM callrail_call_tags WHERE call_id = ?');
  const addTag = db.prepare('INSERT OR IGNORE INTO callrail_call_tags (call_id, tag) VALUES (?, ?)');
  let maxDate = null;
  db.transaction(() => {
    rows.forEach((row, i) => {
      upsert.run(row);
      clearTags.run(row.id);
      for (const tag of tagNames(calls[i].tags)) addTag.run(row.id, tag);
      if (row.call_date && (!maxDate || row.call_date > maxDate)) maxDate = row.call_date;
    });
  })();
  return { count: rows.length, maxDate };
}

function getWatermark(db, companyId, entity) {
  return db.prepare('SELECT watermark_date FROM sync_state WHERE company_id = ? AND entity = ?')
    .get(companyId, entity)?.watermark_date ?? null;
}

function setWatermark(db, companyId, entity, date, count) {
  db.prepare(`INSERT INTO sync_state (company_id, entity, watermark_date, last_run_at, last_row_count)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(company_id, entity) DO UPDATE SET
                watermark_date = excluded.watermark_date,
                last_run_at = excluded.last_run_at,
                last_row_count = excluded.last_row_count`)
    .run(companyId, entity, date, new Date().toISOString(), count);
}

async function syncCalls(client, db, company, args, salt) {
  const id = String(company.id);
  const { startDate, endDate } = windowFor({ watermark: getWatermark(db, id, 'calls'), ...args });
  process.stdout.write(`  calls          ${startDate} → ${endDate}\n`);
  const fetchedAt = new Date().toISOString();
  let count = 0;
  let maxDate = null;
  for await (const batch of client.calls(id, { startDate, endDate, fields: CALL_FIELDS })) {
    const r = writeCalls(db, batch, { salt, fetchedAt, companyId: id });
    count += r.count;
    if (r.maxDate && (!maxDate || r.maxDate > maxDate)) maxDate = r.maxDate;
    if (args.verbose) console.log(`     … ${count}`);
  }
  setWatermark(db, id, 'calls', maxDate ?? getWatermark(db, id, 'calls') ?? endDate, count);
  process.stdout.write(`                 → ${count} calls\n`);
  return count;
}

async function syncForms(client, db, company, args, salt) {
  const id = String(company.id);
  const { startDate, endDate } = windowFor({ watermark: getWatermark(db, id, 'form_submissions'), ...args });
  process.stdout.write(`  forms          ${startDate} → ${endDate}\n`);
  const fetchedAt = new Date().toISOString();
  let count = 0;
  let maxDate = null;
  try {
    for await (const batch of client.formSubmissions(id, { startDate, endDate })) {
      const rows = batch.map((f) => toFormRow(f, { salt, fetchedAt, companyId: id }));
      const upsert = makeUpsert(db, 'callrail_form_submissions', rows[0]);
      db.transaction(() => rows.forEach((r) => upsert.run(r)))();
      for (const r of rows) if (r.submitted_date && (!maxDate || r.submitted_date > maxDate)) maxDate = r.submitted_date;
      count += rows.length;
    }
  } catch (err) {
    // Form tracking is a separate CallRail product; accounts without it refuse the endpoint.
    if (err.status === 403 || err.status === 404) {
      process.stdout.write(`                 (skipped — form tracking not available: HTTP ${err.status})\n`);
      return 0;
    }
    throw err;
  }
  setWatermark(db, id, 'form_submissions', maxDate ?? getWatermark(db, id, 'form_submissions') ?? endDate, count);
  process.stdout.write(`                 → ${count} form submissions\n`);
  return count;
}

async function main() {
  dotenv.config({ path: join(INSTANCE_ROOT, 'env.local'), quiet: true });
  const args = parseArgs(process.argv.slice(2));
  const allowlist = (process.env.CALLRAIL_COMPANY_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const client = new CallRailClient({
    apiKey: process.env.CALLRAIL_API_KEY,
    accountId: process.env.CALLRAIL_ACCOUNT_ID || null,
    verbose: args.verbose,
  });

  if (!client.accountId) {
    const accounts = await client.listAccounts();
    console.error('CALLRAIL_ACCOUNT_ID is not set. Accounts visible to this key:\n  '
      + (accounts.map((a) => `${a.id}  ${a.name ?? ''}`).join('\n  ') || '(none)'));
    process.exit(1);
  }

  const db = openDb();
  const started = Date.now();
  const salt = loadSalt(SALT_PATH);
  const fetchedAt = new Date().toISOString();

  const visible = await client.listCompanies();
  const { targets, error } = resolveCompanies(visible, allowlist, args.company);
  if (error) {
    console.error(`${error}\nVisible:\n  ${visible.map((c) => `${c.id}  ${c.name}`).join('\n  ')}`);
    process.exit(1);
  }

  console.log(`📞 CallRail · ${targets.length} compan${targets.length === 1 ? 'y' : 'ies'}${args.full ? ' · full pull' : ''}`);

  let total = 0;
  for (const company of targets) {
    console.log(`\n${company.id}  ${company.name}${company.time_zone ? `  [${company.time_zone}]` : ''}`);
    const companyRow = toCompanyRow(company, { fetchedAt });
    makeUpsert(db, 'callrail_companies', companyRow).run(companyRow);

    const trackers = await client.listTrackers(company.id);
    if (trackers.length) {
      const rows = trackers.map((t) => toTrackerRow(t, { fetchedAt, companyId: String(company.id) }));
      const upsert = makeUpsert(db, 'callrail_trackers', rows[0]);
      db.transaction(() => rows.forEach((r) => upsert.run(r)))();
    }
    console.log(`  trackers       → ${trackers.length}`);

    total += await syncCalls(client, db, company, args, salt);
    if (args.forms) total += await syncForms(client, db, company, args, salt);
  }

  console.log(`\n✅ ${total} rows in ${((Date.now() - started) / 1000).toFixed(1)}s → ${DB_PATH}`);
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  });
}
