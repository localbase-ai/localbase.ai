#!/usr/bin/env node
/**
 * Sync Google Analytics 4 into data/google-analytics/ga.db.
 *
 *   node connectors/google-analytics/sync.js                        incremental, allowed properties
 *   node connectors/google-analytics/sync.js --full                 from property creation
 *   node connectors/google-analytics/sync.js --property 123456789   one property
 *   node connectors/google-analytics/sync.js --reports daily,channel
 *   node connectors/google-analytics/sync.js --verbose
 *
 * Watermarks live in sync_state, one row per (property, report).
 */
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { AnalyticsClient } from './client.js';
import {
  REPORTS, PROPERTIES_DDL, STATE_DDL, toRow, FINALISATION_DAYS, EARLIEST_DATE,
} from './reports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTANCE_ROOT = join(__dirname, '..', '..');
const DB_PATH = join(INSTANCE_ROOT, 'data', 'google-analytics', 'ga.db');

dotenv.config({ path: join(INSTANCE_ROOT, 'env.local'), quiet: true });

/**
 * Properties this instance is allowed to sync.
 *
 * The authorised Google account can see every property it owns, not just this
 * business's. Syncing "everything visible" has pulled an unrelated business's
 * property into a client database before — wrong numbers on any unfiltered
 * aggregate, and a client boundary crossed, since anyone given access to the
 * workspace could read it.
 *
 * An allowlist rather than a default flag: the flag only protects the runs that
 * remember to pass it, and the scheduled run is not the one that forgets.
 * Required: GA4_PROPERTIES in env.local (comma-separated property IDs).
 * `authorize.js` prints the IDs this account can see.
 */
const ALLOWED_PROPERTIES = (process.env.GA4_PROPERTIES ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(PROPERTIES_DDL);
  db.exec(STATE_DDL);
  for (const r of REPORTS) db.exec(r.ddl);
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

function getWatermark(db, property, report) {
  return db.prepare('SELECT watermark_date FROM sync_state WHERE property = ? AND report = ?')
    .get(property, report)?.watermark_date ?? null;
}

function setWatermark(db, property, report, date, rowCount) {
  db.prepare(`INSERT INTO sync_state (property, report, watermark_date, last_run_at, last_row_count)
              VALUES (@property, @report, @date, @now, @count)
              ON CONFLICT(property, report) DO UPDATE SET
                watermark_date = excluded.watermark_date,
                last_run_at = excluded.last_run_at,
                last_row_count = excluded.last_row_count`)
    .run({ property, report, date, now: new Date().toISOString(), count: rowCount });
}

/**
 * The window to request. There is no point asking for dates before the property
 * existed, so a full pull starts at its creation date.
 */
function windowFor(db, property, report, full, createdAt) {
  const end = iso(new Date());          // GA4 accepts "today"; today's data is partial but useful
  const floor = createdAt ? iso(new Date(createdAt)) : EARLIEST_DATE;
  if (full) return { startDate: floor, endDate: end };

  const mark = getWatermark(db, property, report);
  if (!mark) return { startDate: floor, endDate: end };

  const from = new Date(`${mark}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - FINALISATION_DAYS);
  return { startDate: iso(from) < floor ? floor : iso(from), endDate: end };
}

async function syncReport(client, db, propertyId, report, { full, verbose }, createdAt) {
  const { startDate, endDate } = windowFor(db, propertyId, report.name, full, createdAt);
  process.stdout.write(`  ${report.name.padEnd(14)} ${full ? 'full' : `${startDate} → ${endDate}`}\n`);

  const fetchedAt = new Date().toISOString();
  const request = {
    dateRanges: [{ startDate, endDate }],
    dimensions: report.dimensions.map((name) => ({ name })),
    metrics: report.metrics.map((name) => ({ name })),
  };

  let upsert = null;
  let count = 0;
  let maxDate = null;

  for await (const page of client.runReportAll(propertyId, request, { costKey: report.name })) {
    const mapped = page.rows.map((r) => toRow(report, r, {
      property: propertyId,
      fetchedAt,
      dimensionHeaders: page.dimensionHeaders,
      metricHeaders: page.metricHeaders,
    }));
    if (!upsert) upsert = makeUpsert(db, report.table, mapped[0]);
    db.transaction((batch) => batch.forEach((r) => upsert.run(r)))(mapped);
    for (const r of mapped) if (r.date && (!maxDate || r.date > maxDate)) maxDate = r.date;
    count += mapped.length;
  }

  setWatermark(db, propertyId, report.name, maxDate ?? endDate, count);
  process.stdout.write(`  ${''.padEnd(14)} → ${count} rows\n`);
  return count;
}

function parseArgs(argv) {
  const args = { full: false, verbose: false, property: null, reports: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--property') args.property = argv[++i];
    else if (a === '--reports') args.reports = argv[++i].split(',').map((s) => s.trim());
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!ALLOWED_PROPERTIES.length) {
    console.error('GA4_PROPERTIES is not set. Add the property IDs for this business to env.local\n'
      + '(comma-separated). node connectors/google-analytics/authorize.js lists the ones you can see.');
    process.exit(1);
  }
  const client = new AnalyticsClient({ verbose: args.verbose });
  const db = openDb();
  const started = Date.now();

  const summaries = await client.listPropertySummaries();
  if (!summaries.length) {
    console.error('No GA4 properties are visible to this account.');
    process.exit(1);
  }

  const permitted = summaries.filter((p) => ALLOWED_PROPERTIES.includes(p.propertyId));
  const excluded = summaries.filter((p) => !ALLOWED_PROPERTIES.includes(p.propertyId));
  if (excluded.length) {
    console.log(`   skipping ${excluded.length} property(ies) not on the allowlist: `
      + excluded.map((p) => `${p.propertyId} ${p.displayName}`).join(', '));
  }
  if (!permitted.length) {
    console.error('None of the visible properties are on the allowlist '
      + `(${ALLOWED_PROPERTIES.join(', ')}). Visible:\n  `
      + summaries.map((p) => `${p.propertyId}  ${p.displayName}`).join('\n  '));
    process.exit(1);
  }

  const targets = permitted.filter((p) => !args.property || p.propertyId === args.property);
  if (!targets.length) {
    console.error(`No allowed property matches "${args.property}". Allowed and visible:\n  `
      + permitted.map((p) => `${p.propertyId}  ${p.displayName}`).join('\n  '));
    process.exit(1);
  }

  const reports = args.reports ? REPORTS.filter((r) => args.reports.includes(r.name)) : REPORTS;
  console.log(`📊 GA4 · ${targets.length} propert${targets.length === 1 ? 'y' : 'ies'}`
    + ` · reports: ${reports.map((r) => r.name).join(', ')}${args.full ? ' · full pull' : ''}`);

  const upsertProp = db.prepare(`INSERT INTO ga_properties
    (property, display_name, account_name, property_type, create_time, time_zone, currency_code, industry_category, first_seen_at, last_synced_at)
    VALUES (@property, @display, @account, @type, @created, @tz, @currency, @industry, @now, @now)
    ON CONFLICT(property) DO UPDATE SET
      display_name = excluded.display_name, account_name = excluded.account_name,
      property_type = excluded.property_type, create_time = excluded.create_time,
      time_zone = excluded.time_zone, currency_code = excluded.currency_code,
      industry_category = excluded.industry_category, last_synced_at = excluded.last_synced_at`);

  let total = 0;
  for (const p of targets) {
    let meta = {};
    try {
      meta = await client.getProperty(p.propertyId);
    } catch (err) {
      console.log(`  (could not read property metadata: ${err.message})`);
    }
    console.log(`\n${p.propertyId}  ${p.displayName}`
      + (meta.timeZone ? `  [${meta.timeZone}]` : ''));
    upsertProp.run({
      property: p.propertyId, display: p.displayName, account: p.accountName,
      type: p.propertyType, created: meta.createTime ?? null, tz: meta.timeZone ?? null,
      currency: meta.currencyCode ?? null, industry: meta.industryCategory ?? null,
      now: new Date().toISOString(),
    });
    for (const report of reports) {
      total += await syncReport(client, db, p.propertyId, report, args, meta.createTime);
    }
  }

  console.log(`\n✅ ${total} rows in ${((Date.now() - started) / 1000).toFixed(1)}s → ${DB_PATH}`);
  db.close();
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
