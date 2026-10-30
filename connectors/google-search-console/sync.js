#!/usr/bin/env node
/**
 * Sync Google Search Console into data/google-search-console/gsc.db.
 *
 *   node connectors/google-search-console/sync.js                 incremental, every allowed site
 *   node connectors/google-search-console/sync.js --full          re-pull the full 16 months
 *   node connectors/google-search-console/sync.js --site <url>    one allowed site
 *   node connectors/google-search-console/sync.js --reports daily,query
 *   node connectors/google-search-console/sync.js --types web,image
 *   node connectors/google-search-console/sync.js --verbose
 *
 * Watermarks live in sync_state, one row per (site, report, search_type).
 */
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { SearchConsoleClient } from './client.js';
import {
  REPORTS, SITES_DDL, STATE_DDL, toRow,
  DEFAULT_SEARCH_TYPES, ALL_SEARCH_TYPES, FINALISATION_DAYS, MAX_LOOKBACK_DAYS,
} from './reports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTANCE_ROOT = join(__dirname, '..', '..');
const DB_PATH = join(INSTANCE_ROOT, 'data', 'google-search-console', 'gsc.db');

dotenv.config({ path: join(INSTANCE_ROOT, 'env.local'), quiet: true });

/**
 * The login usually sees other businesses' properties too, and syncing one here
 * would put another business's data in this workspace. An allowlist rather than
 * a default flag: the flag only protects the runs that remember to pass it.
 * Required: GSC_SITES in env.local (comma-separated site URLs exactly as Search
 * Console lists them, e.g. sc-domain:example.com). `authorize.js` prints them.
 */
const ALLOWED_SITES = (process.env.GSC_SITES ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/* ------------------------------------------------------------ db setup --- */

function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(SITES_DDL);
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

/* -------------------------------------------------------------- dates ---- */

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };

function getWatermark(db, site, report, searchType) {
  return db.prepare(
    'SELECT watermark_date FROM sync_state WHERE site = ? AND report = ? AND search_type = ?'
  ).get(site, report, searchType)?.watermark_date ?? null;
}

function setWatermark(db, site, report, searchType, date, rowCount) {
  db.prepare(`INSERT INTO sync_state (site, report, search_type, watermark_date, last_run_at, last_row_count)
              VALUES (@site, @report, @type, @date, @now, @count)
              ON CONFLICT(site, report, search_type) DO UPDATE SET
                watermark_date = excluded.watermark_date,
                last_run_at = excluded.last_run_at,
                last_row_count = excluded.last_row_count`)
    .run({ site, report, type: searchType, date, now: new Date().toISOString(), count: rowCount });
}

/**
 * The window to request. Incremental runs start a few days behind the watermark
 * because Search Console keeps revising recent days for roughly 48-72 hours;
 * a strict high-water mark would freeze those days at their first, incomplete
 * values and never correct them.
 */
function windowFor(db, site, report, searchType, full) {
  const end = daysAgo(1); // today is never complete
  if (full) return { startDate: daysAgo(MAX_LOOKBACK_DAYS), endDate: end };

  const mark = getWatermark(db, site, report, searchType);
  if (!mark) return { startDate: daysAgo(MAX_LOOKBACK_DAYS), endDate: end };

  const from = new Date(`${mark}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - FINALISATION_DAYS);
  const floor = daysAgo(MAX_LOOKBACK_DAYS);
  return { startDate: iso(from) < floor ? floor : iso(from), endDate: end };
}

/* --------------------------------------------------------------- sync ---- */

async function syncReport(client, db, site, report, searchType, { full, verbose }) {
  const { startDate, endDate } = windowFor(db, site, report.name, searchType, full);
  if (startDate > endDate) {
    process.stdout.write(`  ${report.name.padEnd(12)} ${searchType.padEnd(6)} up to date\n`);
    return 0;
  }

  const label = full ? 'full' : `${startDate} → ${endDate}`;
  process.stdout.write(`  ${report.name.padEnd(12)} ${searchType.padEnd(6)} ${label}\n`);

  const fetchedAt = new Date().toISOString();
  let upsert = null;
  let count = 0;
  let maxDate = null;

  const request = {
    startDate,
    endDate,
    dimensions: report.dimensions,
    type: searchType,
    dataState: 'final',
  };

  for await (const { rows } of client.queryAll(site, request, { costKey: report.name })) {
    const mapped = rows.map((r) => toRow(report, r, {
      site, searchType, fetchedAt, window: { startDate, endDate },
    }));
    if (!upsert) upsert = makeUpsert(db, report.table, mapped[0]);
    db.transaction((batch) => batch.forEach((r) => upsert.run(r)))(mapped);
    for (const r of mapped) if (r.date && (!maxDate || r.date > maxDate)) maxDate = r.date;
    count += mapped.length;
  }

  // Advance to the requested end even when a day returned nothing — otherwise a
  // quiet property re-requests the same empty window forever.
  setWatermark(db, site, report.name, searchType, maxDate && maxDate > endDate ? maxDate : endDate, count);
  process.stdout.write(`  ${''.padEnd(12)} ${''.padEnd(6)} → ${count} rows\n`);
  return count;
}

/* --------------------------------------------------------------- main ---- */

function parseArgs(argv) {
  const args = { full: false, verbose: false, site: null, reports: null, types: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--site') args.site = argv[++i];
    else if (a === '--reports') args.reports = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--types') args.types = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--all-types') args.types = ALL_SEARCH_TYPES;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!ALLOWED_SITES.length) {
    console.error('GSC_SITES is not set. Add the site URLs for this business to env.local\n'
      + '(comma-separated). node connectors/google-search-console/authorize.js lists the ones you can see.');
    process.exit(1);
  }
  const client = new SearchConsoleClient({ verbose: args.verbose });
  const db = openDb();

  const started = Date.now();
  const sites = await client.listSites();
  if (!sites.length) {
    console.error('No Search Console properties are visible to this account.');
    process.exit(1);
  }

  const upsertSite = db.prepare(`INSERT INTO gsc_sites (site, permission_level, first_seen_at, last_synced_at)
    VALUES (@site, @perm, @now, @now)
    ON CONFLICT(site) DO UPDATE SET permission_level = excluded.permission_level, last_synced_at = excluded.last_synced_at`);

  const permitted = sites.filter((s) => ALLOWED_SITES.includes(s.siteUrl));
  const excluded = sites.filter((s) => !ALLOWED_SITES.includes(s.siteUrl));
  if (excluded.length) {
    console.log(`   skipping ${excluded.length} propert${excluded.length === 1 ? 'y' : 'ies'} not on the allowlist: `
      + excluded.map((s) => s.siteUrl).join(', '));
  }
  if (!permitted.length) {
    console.error(`None of the visible properties are on the allowlist (${ALLOWED_SITES.join(', ')}). Visible:\n  `
      + sites.map((s) => s.siteUrl).join('\n  '));
    process.exit(1);
  }
  const targets = permitted.filter((s) => !args.site || s.siteUrl === args.site);
  if (!targets.length) {
    console.error(`No allowed property matches "${args.site}". Allowed and visible:\n  `
      + permitted.map((s) => s.siteUrl).join('\n  '));
    process.exit(1);
  }

  const reports = args.reports ? REPORTS.filter((r) => args.reports.includes(r.name)) : REPORTS;
  const types = args.types ?? DEFAULT_SEARCH_TYPES;

  console.log(`🔎 Search Console · ${targets.length} propert${targets.length === 1 ? 'y' : 'ies'}`
    + ` · reports: ${reports.map((r) => r.name).join(', ')} · types: ${types.join(', ')}`
    + (args.full ? ' · full 16-month pull' : ''));

  let total = 0;
  for (const site of targets) {
    console.log(`\n${site.siteUrl}  [${site.permissionLevel}]`);
    if (site.permissionLevel === 'siteUnverifiedUser') {
      console.log('  skipped — unverified, the API returns no data for this property');
      continue;
    }
    upsertSite.run({ site: site.siteUrl, perm: site.permissionLevel, now: new Date().toISOString() });
    for (const searchType of types) {
      for (const report of reports) {
        total += await syncReport(client, db, site.siteUrl, report, searchType, args);
      }
    }
  }

  console.log(`\n✅ ${total} rows in ${((Date.now() - started) / 1000).toFixed(1)}s → ${DB_PATH}`);
  db.close();
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
