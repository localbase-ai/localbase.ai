#!/usr/bin/env node
/**
 * Sync Google Merchant Center into data/google-merchant-center/merchant.db.
 *
 *   node connectors/google-merchant-center/sync.js                       all reports, incremental
 *   node connectors/google-merchant-center/sync.js --full                performance from FULL_LOOKBACK_DAYS
 *   node connectors/google-merchant-center/sync.js --account 123456789   one account
 *   node connectors/google-merchant-center/sync.js --reports products,performance,issues
 *   node connectors/google-merchant-center/sync.js --verbose
 *
 * Products and account issues are snapshots (re-fetched whole every run);
 * performance is daily with a watermark per account in sync_state.
 */
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { MerchantClient } from './client.js';
import {
  productToRows, performanceToRow, accountIssueToRow, performanceQuery, performanceWindow,
} from './reports.js';
import {
  initDb, writeProductSnapshot, writeRows, writeAccountIssues, getWatermark, setWatermark,
} from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTANCE_ROOT = join(__dirname, '..', '..');
const DB_PATH = join(INSTANCE_ROOT, 'data', 'google-merchant-center', 'merchant.db');

dotenv.config({ path: join(INSTANCE_ROOT, 'env.local'), quiet: true });

/**
 * Accounts this workspace may sync. The signed-in Google account can often
 * reach other businesses' Merchant Center accounts (an agency login, an
 * advanced account with sub-accounts), and syncing "everything visible" would
 * copy their catalogues into this workspace. Required, comma-separated.
 */
const ALLOWED_ACCOUNTS = (process.env.MERCHANT_ACCOUNT_IDS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const ALL_REPORTS = ['products', 'performance', 'issues'];

const iso = (d) => d.toISOString().slice(0, 10);

function parseArgs(argv) {
  const args = { full: false, verbose: false, account: null, reports: ALL_REPORTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--account') args.account = argv[++i];
    else if (a === '--reports') args.reports = argv[++i].split(',').map((s) => s.trim());
  }
  return args;
}

async function syncProducts(client, db, accountId) {
  const seenAt = new Date().toISOString();
  const rows = [];
  for await (const page of client.listProducts(accountId)) {
    for (const p of page) rows.push(productToRows(p, { accountId, seenAt }));
  }
  // Written only after the whole catalogue arrived: a half-finished pull would
  // otherwise stamp every unfetched product as disappeared.
  const gone = writeProductSnapshot(db, accountId, rows, seenAt);
  const issues = rows.reduce((n, r) => n + r.issues.length, 0);
  console.log(`  products       → ${rows.length} products, ${issues} item issues`
    + (gone ? `, ${gone} disappeared since last run` : ''));
  setWatermark(db, accountId, 'products', iso(new Date()), rows.length);
  return rows.length;
}

async function syncPerformance(client, db, accountId, { full }) {
  const { startDate, endDate } = performanceWindow(getWatermark(db, accountId, 'performance'), full);
  const fetchedAt = new Date().toISOString();
  let count = 0;
  let maxDate = null;
  for await (const page of client.search(accountId, performanceQuery(startDate, endDate))) {
    const rows = page.filter((r) => r.productPerformanceView)
      .map((r) => performanceToRow(r, { accountId, fetchedAt }));
    count += writeRows(db, 'mc_performance_daily', rows);
    for (const r of rows) if (r.date && (!maxDate || r.date > maxDate)) maxDate = r.date;
  }
  setWatermark(db, accountId, 'performance', maxDate ?? endDate, count);
  console.log(`  performance    ${startDate} → ${endDate}: ${count} rows`);
  return count;
}

async function syncAccountIssues(client, db, accountId) {
  const fetchedAt = new Date().toISOString();
  const issues = await client.listAccountIssues(accountId);
  const n = writeAccountIssues(db, accountId, issues.map((i) => accountIssueToRow(i, { accountId, fetchedAt })));
  setWatermark(db, accountId, 'issues', iso(new Date()), n);
  console.log(`  account issues → ${n}`);
  return n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new MerchantClient({ verbose: args.verbose });

  if (!ALLOWED_ACCOUNTS.length) {
    let visible = [];
    try { visible = await client.listAccounts(); } catch (err) { console.error(err.message); }
    console.error('\nMERCHANT_ACCOUNT_IDS is not set. Add the Merchant Center account IDs for this '
      + 'business to env.local (comma-separated).'
      + (visible.length ? `\nVisible to this login:\n  ${visible.map((a) => `${a.accountId}  ${a.accountName ?? ''}`).join('\n  ')}` : ''));
    process.exit(1);
  }

  // They go into URL paths; Merchant Center account IDs are numeric.
  const malformed = ALLOWED_ACCOUNTS.filter((id) => !/^\d+$/.test(id));
  if (malformed.length) {
    console.error(`MERCHANT_ACCOUNT_IDS must be numeric account IDs: ${malformed.join(', ')}`);
    process.exit(1);
  }

  const targets = ALLOWED_ACCOUNTS.filter((id) => !args.account || id === args.account);
  if (!targets.length) {
    console.error(`"${args.account}" is not in MERCHANT_ACCOUNT_IDS (${ALLOWED_ACCOUNTS.join(', ')}).`);
    process.exit(1);
  }

  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = initDb(new Database(DB_PATH));
  const started = Date.now();
  const reports = ALL_REPORTS.filter((r) => args.reports.includes(r));
  console.log(`🛒 Merchant Center · ${targets.length} account(s) · ${reports.join(', ')}${args.full ? ' · full' : ''}`);

  const upsertAccount = db.prepare(`INSERT INTO mc_accounts
    (account_id, account_name, time_zone, language_code, test_account, first_seen_at, last_synced_at)
    VALUES (@id, @name, @tz, @lang, @test, @now, @now)
    ON CONFLICT(account_id) DO UPDATE SET account_name = excluded.account_name,
      time_zone = excluded.time_zone, language_code = excluded.language_code,
      test_account = excluded.test_account, last_synced_at = excluded.last_synced_at`);

  let failures = 0;
  for (const accountId of targets) {
    let meta = {};
    try {
      meta = await client.getAccount(accountId);
    } catch (err) {
      // getAccount failing is usually the same registration/permission problem
      // every other call will hit, so say it once and move on.
      console.error(`\n${accountId}: ${err.message}`);
      failures += 1;
      continue;
    }
    console.log(`\n${accountId}  ${meta.accountName ?? ''}`);
    upsertAccount.run({
      id: accountId, name: meta.accountName ?? null, tz: meta.timeZone?.id ?? null,
      lang: meta.languageCode ?? null, test: meta.testAccount ? 1 : 0, now: new Date().toISOString(),
    });

    for (const report of reports) {
      try {
        if (report === 'products') await syncProducts(client, db, accountId);
        if (report === 'performance') await syncPerformance(client, db, accountId, args);
        if (report === 'issues') await syncAccountIssues(client, db, accountId);
      } catch (err) {
        console.error(`  ${report} failed: ${err.message}`);
        failures += 1;
      }
    }
  }

  db.close();
  console.log(`\n${failures ? '⚠️ ' : '✅'} done in ${((Date.now() - started) / 1000).toFixed(1)}s → ${DB_PATH}`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
