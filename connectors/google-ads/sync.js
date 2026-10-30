#!/usr/bin/env node
/**
 * Sync Google Ads into data/google-ads/ads.db.
 *
 *   node connectors/google-ads/sync.js                         incremental, allowed customers
 *   node connectors/google-ads/sync.js --full                  back GOOGLE_ADS_FULL_DAYS (default 3 years)
 *   node connectors/google-ads/sync.js --customer 1234567890   one account
 *   node connectors/google-ads/sync.js --reports campaign,calls
 *   node connectors/google-ads/sync.js --verbose
 *
 * Watermarks live in sync_state, one row per (customer, report).
 */
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { AdsClient, normaliseCustomerId } from './client.js';
import {
  REPORTS, ddlFor, queryFor, toRow, CUSTOMERS_DDL, GEO_TARGETS_DDL, STATE_DDL,
  REVISION_DAYS, FULL_DAYS, CHUNK_DAYS,
} from './reports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTANCE_ROOT = join(__dirname, '..', '..');
const DB_PATH = join(INSTANCE_ROOT, 'data', 'google-ads', 'ads.db');

dotenv.config({ path: join(INSTANCE_ROOT, 'env.local'), quiet: true });

/**
 * Accounts this workspace is allowed to sync.
 *
 * A Google login — and especially a manager account — usually reaches more than
 * one business's ad accounts. Syncing "everything visible" would put another
 * business's spend in this database, wrong on any unfiltered SUM and readable
 * by anyone given access here. Required: GOOGLE_ADS_CUSTOMER_IDS in env.local.
 */
const ALLOWED_CUSTOMERS = (process.env.GOOGLE_ADS_CUSTOMER_IDS ?? '')
  .split(',').map(normaliseCustomerId).filter(Boolean);

const fullDays = Number(process.env.GOOGLE_ADS_FULL_DAYS) || FULL_DAYS;

function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(CUSTOMERS_DDL);
  db.exec(GEO_TARGETS_DDL);
  db.exec(STATE_DDL);
  for (const r of REPORTS) db.exec(ddlFor(r));
  return db;
}

function makeUpsert(db, table, sampleRow) {
  const cols = Object.keys(sampleRow);
  const pk = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.pk).map((c) => c.name);
  const updatable = cols.filter((c) => !pk.includes(c));
  return db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
     ON CONFLICT(${pk.join(', ')}) DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(', ')}`
  );
}

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

function getWatermark(db, customerId, report) {
  return db.prepare('SELECT watermark_date FROM sync_state WHERE customer_id = ? AND report = ?')
    .get(customerId, report)?.watermark_date ?? null;
}

function setWatermark(db, customerId, report, date, rowCount) {
  db.prepare(`INSERT INTO sync_state (customer_id, report, watermark_date, last_run_at, last_row_count)
              VALUES (@customerId, @report, @date, @now, @count)
              ON CONFLICT(customer_id, report) DO UPDATE SET
                watermark_date = excluded.watermark_date,
                last_run_at = excluded.last_run_at,
                last_row_count = excluded.last_row_count`)
    .run({ customerId, report, date, now: new Date().toISOString(), count: rowCount });
}

/** The dates to request: everything on a full or first run, else a trailing revision window. */
export function windowFor(watermark, { full, today = iso(new Date()), revisionDays = REVISION_DAYS, floor }) {
  if (full || !watermark) return { startDate: floor, endDate: today };
  const from = addDays(watermark, -revisionDays);
  return { startDate: from < floor ? floor : from, endDate: today };
}

/** Split [start, end] into windows of at most `size` days, inclusive. */
export function chunks(startDate, endDate, size = CHUNK_DAYS) {
  const out = [];
  for (let s = startDate; s <= endDate; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    out.push({ startDate: s, endDate: e < endDate ? e : endDate });
  }
  return out;
}

async function syncReport(client, db, customerId, report, args) {
  const fetchedAt = new Date().toISOString();
  let upsert = null;
  let count = 0;
  let maxDate = null;

  const write = (results) => {
    const rows = results.map((r) => toRow(report, r, { customerId, fetchedAt }));
    if (!rows.length) return;
    upsert ??= makeUpsert(db, report.table, rows[0]);
    db.transaction((batch) => batch.forEach((r) => upsert.run(r)))(rows);
    for (const r of rows) {
      const d = r.date ?? r.start_call_date_time?.slice(0, 10);
      if (d && (!maxDate || d > maxDate)) maxDate = d;
    }
    count += rows.length;
  };

  if (!report.dated) {
    process.stdout.write(`  ${report.name.padEnd(18)} whole\n`);
    write(await client.search(customerId, queryFor(report)));
    setWatermark(db, customerId, report.name, iso(new Date()), count);
  } else {
    const floor = daysAgo(fullDays);
    const { startDate, endDate } = windowFor(getWatermark(db, customerId, report.name), {
      full: args.full, floor,
    });
    process.stdout.write(`  ${report.name.padEnd(18)} ${startDate} → ${endDate}\n`);
    for (const w of chunks(startDate, endDate)) {
      write(await client.search(customerId, queryFor(report, w)));
    }
    setWatermark(db, customerId, report.name, maxDate ?? endDate, count);
  }

  process.stdout.write(`  ${''.padEnd(18)} → ${count} rows\n`);
  return count;
}

/** Location ids in ads_geo_daily are resource names; look up the ones not yet named. */
async function resolveGeoTargets(client, db, customerId) {
  const unresolved = db.prepare(`
    SELECT DISTINCT g FROM (
      SELECT geo_target_city AS g FROM ads_geo_daily
      UNION SELECT 'geoTargetConstants/' || country_criterion_id FROM ads_geo_daily
    ) WHERE g <> '' AND g <> 'geoTargetConstants/' AND g NOT IN (SELECT geo_target FROM ads_geo_targets)
  `).all().map((r) => r.g)
    // These are quoted into GAQL below; only well-formed resource names get there.
    .filter((g) => /^geoTargetConstants\/\d+$/.test(g));
  if (!unresolved.length) return;

  const insert = db.prepare(`INSERT OR REPLACE INTO ads_geo_targets
    (geo_target, name, canonical_name, target_type, country_code)
    VALUES (@geo_target, @name, @canonical_name, @target_type, @country_code)`);
  for (let i = 0; i < unresolved.length; i += 500) {
    const batch = unresolved.slice(i, i + 500);
    const rows = await client.search(customerId,
      'SELECT geo_target_constant.resource_name, geo_target_constant.name, '
      + 'geo_target_constant.canonical_name, geo_target_constant.target_type, '
      + 'geo_target_constant.country_code FROM geo_target_constant '
      + `WHERE geo_target_constant.resource_name IN (${batch.map((g) => `'${g}'`).join(', ')})`);
    db.transaction(() => {
      for (const { geoTargetConstant: g } of rows) {
        if (!g) continue;
        insert.run({
          geo_target: g.resourceName,
          name: g.name ?? null,
          canonical_name: g.canonicalName ?? null,
          target_type: g.targetType ?? null,
          country_code: g.countryCode ?? null,
        });
      }
    })();
  }
  console.log(`  geo names          → ${unresolved.length} location(s) resolved`);
}

function parseArgs(argv) {
  const args = { full: false, verbose: false, customer: null, reports: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--customer') args.customer = normaliseCustomerId(argv[++i]);
    else if (a === '--reports') args.reports = argv[++i].split(',').map((s) => s.trim());
  }
  return args;
}

async function listVisible(client) {
  const ids = await client.listAccessibleCustomers().catch(() => []);
  const managed = await client.listManagedCustomers().catch(() => []);
  const lines = ids.map((id) => `  ${id}  (direct access)`);
  for (const c of managed) if (!c.manager) lines.push(`  ${c.id}  ${c.descriptiveName ?? ''}  (via manager)`);
  return lines.length ? lines.join('\n') : '  (none visible)';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new AdsClient({ verbose: args.verbose });

  if (!ALLOWED_CUSTOMERS.length) {
    console.error('GOOGLE_ADS_CUSTOMER_IDS is not set. Add the ad account id(s) for this business to '
      + 'env.local (comma-separated, dashes optional). Accounts this login can see:\n'
      + await listVisible(client));
    process.exit(1);
  }

  const targets = ALLOWED_CUSTOMERS.filter((id) => !args.customer || id === args.customer);
  if (!targets.length) {
    console.error(`"${args.customer}" is not in GOOGLE_ADS_CUSTOMER_IDS (${ALLOWED_CUSTOMERS.join(', ')}).`);
    process.exit(1);
  }

  const reports = args.reports ? REPORTS.filter((r) => args.reports.includes(r.name)) : REPORTS;
  if (!reports.length) {
    console.error(`No such report. Choose from: ${REPORTS.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }

  const db = openDb();
  const started = Date.now();
  console.log(`📣 Google Ads ${client.version} · ${targets.length} account${targets.length === 1 ? '' : 's'}`
    + ` · reports: ${reports.map((r) => r.name).join(', ')}${args.full ? ' · full pull' : ''}`);

  const upsertCustomer = db.prepare(`INSERT INTO ads_customers
    (customer_id, descriptive_name, currency_code, time_zone, is_manager, is_test_account, first_seen_at, last_synced_at)
    VALUES (@id, @name, @currency, @tz, @manager, @test, @now, @now)
    ON CONFLICT(customer_id) DO UPDATE SET
      descriptive_name = excluded.descriptive_name, currency_code = excluded.currency_code,
      time_zone = excluded.time_zone, is_manager = excluded.is_manager,
      is_test_account = excluded.is_test_account, last_synced_at = excluded.last_synced_at`);

  let total = 0;
  for (const customerId of targets) {
    const c = await client.describeCustomer(customerId);
    if (!c) {
      // Re-run one cheap query unguarded so the real error (with its hint) surfaces.
      await client.search(customerId, 'SELECT customer.id FROM customer LIMIT 1');
    }
    console.log(`\n${customerId}  ${c?.descriptiveName ?? ''}  [${c?.currencyCode ?? '?'} · ${c?.timeZone ?? '?'}]`);
    if (c?.manager) {
      console.log('  is a manager account — it has no ads of its own. List client account ids in '
        + 'GOOGLE_ADS_CUSTOMER_IDS and keep this one in GOOGLE_ADS_LOGIN_CUSTOMER_ID.');
      continue;
    }
    upsertCustomer.run({
      id: customerId, name: c?.descriptiveName ?? null, currency: c?.currencyCode ?? null,
      tz: c?.timeZone ?? null, manager: String(c?.manager ?? false), test: String(c?.testAccount ?? false),
      now: new Date().toISOString(),
    });
    for (const report of reports) total += await syncReport(client, db, customerId, report, args);
    if (reports.some((r) => r.name === 'geo')) await resolveGeoTargets(client, db, customerId);
  }

  console.log(`\n✅ ${total} rows in ${((Date.now() - started) / 1000).toFixed(1)}s → ${DB_PATH}`);
  db.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  });
}
