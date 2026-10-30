#!/usr/bin/env node
/**
 * Sync Meta (ads, Facebook Page, Instagram) into data/meta/meta.db.
 *
 *   node connectors/meta/sync.js                       incremental, allowed assets
 *   node connectors/meta/sync.js --full                ads: 37 months; organic: 2 years
 *   node connectors/meta/sync.js --reports ads,page,instagram
 *   node connectors/meta/sync.js --account 123456789   one ad account
 *   node connectors/meta/sync.js --verbose             shows usage headers and job progress
 *
 * Watermarks live in sync_state, one row per (object, report). Incremental
 * runs re-pull REVISION_DAYS behind the watermark, because Meta restates.
 */
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { MetaClient } from './client.js';
import {
  LEVELS, INSIGHT_FIELDS, OBJECT_FIELDS, OBJECT_TABLE, OBJECTS_DDL, ORGANIC_DDL, ACTIONS_DDL,
  STATE_DDL, REVISION_DAYS, ASYNC_THRESHOLD_DAYS, ADS_HISTORY_MONTHS, PAGE_WINDOW_DAYS,
  IG_WINDOW_DAYS, ORGANIC_HISTORY_DAYS, MEDIA_REFRESH_DAYS, DEFAULT_PAGE_METRICS,
  DEFAULT_POST_METRICS, DEFAULT_IG_MEDIA_METRICS,
  insightDdl, insightTable, insightToRow, actionRows, objectToRow, seriesRows, totalValueRows,
  lifetimeRows, postToRow, mediaToRow, normaliseAdAccountId, parseList, parseIgMetrics,
  resolveTargets, iso, addDays, daysBetween, chunkWindow, monthsAgo,
} from './reports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTANCE_ROOT = join(__dirname, '..', '..');
const DB_PATH = join(INSTANCE_ROOT, 'data', 'meta', 'meta.db');

dotenv.config({ path: join(INSTANCE_ROOT, 'env.local'), quiet: true });

/**
 * Assets this workspace is allowed to sync.
 *
 * A Meta token — a System User's especially — routinely reaches ad accounts
 * and Pages belonging to other businesses (an agency's, a partner's). Syncing
 * "everything visible" would pull them into this workspace's database, where
 * anyone with access to it could read them. So nothing syncs without an
 * explicit allowlist; with none set, the run stops and lists what it can see.
 */
const AD_ACCOUNTS = parseList(process.env.META_AD_ACCOUNT_IDS).map(normaliseAdAccountId);
const PAGES = parseList(process.env.META_PAGE_IDS);
const IG_USERS = parseList(process.env.META_IG_USER_IDS);

const PAGE_METRICS = parseList(process.env.META_PAGE_METRICS).length
  ? parseList(process.env.META_PAGE_METRICS) : DEFAULT_PAGE_METRICS;
const POST_METRICS = parseList(process.env.META_POST_METRICS).length
  ? parseList(process.env.META_POST_METRICS) : DEFAULT_POST_METRICS;
const IG_METRICS = parseIgMetrics(process.env.META_IG_METRICS);
const IG_MEDIA_METRICS = parseList(process.env.META_IG_MEDIA_METRICS).length
  ? parseList(process.env.META_IG_MEDIA_METRICS) : DEFAULT_IG_MEDIA_METRICS;

function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(STATE_DDL);
  db.exec(OBJECTS_DDL);
  db.exec(ORGANIC_DDL);
  db.exec(ACTIONS_DDL);
  for (const level of LEVELS) db.exec(insightDdl(level));
  return db;
}

/** Upsert keyed on the table's primary key; statements cached per table+shape. */
function makeUpserter(db) {
  const cache = new Map();
  return (table, rows) => {
    if (!rows.length) return 0;
    const cols = Object.keys(rows[0]);
    const key = `${table}|${cols.join(',')}`;
    if (!cache.has(key)) {
      const pk = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.pk).map((c) => c.name);
      const updatable = cols.filter((c) => !pk.includes(c));
      cache.set(key, db.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
         ON CONFLICT(${pk.join(', ')}) DO ${updatable.length
          ? `UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(', ')}`
          : 'NOTHING'}`
      ));
    }
    const stmt = cache.get(key);
    db.transaction((batch) => batch.forEach((r) => stmt.run(r)))(rows);
    return rows.length;
  };
}

function getWatermark(db, objectId, report) {
  return db.prepare('SELECT watermark_date FROM sync_state WHERE object_id = ? AND report = ?')
    .get(objectId, report)?.watermark_date ?? null;
}

function setWatermark(db, objectId, report, date, rowCount) {
  db.prepare(`INSERT INTO sync_state (object_id, report, watermark_date, last_run_at, last_row_count)
              VALUES (@objectId, @report, @date, @now, @count)
              ON CONFLICT(object_id, report) DO UPDATE SET
                watermark_date = excluded.watermark_date,
                last_run_at = excluded.last_run_at,
                last_row_count = excluded.last_row_count`)
    .run({ objectId, report, date, now: new Date().toISOString(), count: rowCount });
}

/** [since, until] for one object's report: full floor, or watermark minus the revision window. */
function windowFor(db, objectId, report, { full, floor }) {
  const until = iso(new Date());
  const mark = full ? null : getWatermark(db, objectId, report);
  if (!mark) return { since: floor, until };
  const since = addDays(mark, -REVISION_DAYS);
  return { since: since < floor ? floor : since, until };
}

function recordMetricErrors(db, scope, objectId, failed) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`INSERT INTO meta_metric_errors (scope, object_id, metric, error, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, object_id, metric) DO UPDATE SET error = excluded.error, last_seen_at = excluded.last_seen_at`);
  for (const f of failed) {
    stmt.run(scope, objectId, f.metric, f.error, now, now);
    console.log(`     ⚠︎ skipped ${scope} metric "${f.metric}" — ${f.error}`);
  }
}

/* ------------------------------------------------------------------ ads -- */

async function syncAds(client, db, upsert, account, args) {
  const accountId = normaliseAdAccountId(account.id);
  const fetchedAt = new Date().toISOString();
  console.log(`\nact_${accountId}  ${account.name ?? ''}  [${account.currency ?? '?'} · ${account.timezone_name ?? '?'}]`);

  upsert('meta_ad_accounts', [{
    account_id: accountId, name: account.name ?? null, currency: account.currency ?? null,
    timezone_name: account.timezone_name ?? null, account_status: account.account_status ?? null,
    last_synced_at: fetchedAt,
  }]);

  for (const level of LEVELS) {
    const objects = await client.all(`act_${accountId}/${level === 'adset' ? 'adsets' : `${level}s`}`, {
      params: { fields: OBJECT_FIELDS[level].join(','), limit: 200 },
    });
    upsert(OBJECT_TABLE[level], objects.map((o) => objectToRow(level, o, { accountId, fetchedAt })));
    console.log(`  ${`${level}s`.padEnd(16)} ${objects.length} objects`);
  }

  let total = 0;
  const floor = monthsAgo(ADS_HISTORY_MONTHS);
  for (const level of LEVELS) {
    const report = `insights_${level}`;
    const { since, until } = windowFor(db, accountId, report, { full: args.full, floor });
    const useAsync = daysBetween(since, until) > ASYNC_THRESHOLD_DAYS;
    process.stdout.write(`  ${report.padEnd(16)} ${since} → ${until}${useAsync ? ' (async job)' : ''}\n`);

    // Even async jobs are chunked by year: one enormous job is the one that fails.
    let count = 0;
    let maxDate = null;
    for (const w of chunkWindow(since, until, useAsync ? 365 : ASYNC_THRESHOLD_DAYS)) {
      const opts = { level, since: w.since, until: w.until, fields: INSIGHT_FIELDS };
      const rows = useAsync
        ? await client.insightsAsync(accountId, opts)
        : await client.insightsSync(accountId, opts);
      upsert(insightTable(level), rows.map((r) => insightToRow(level, r, { fetchedAt })));
      upsert('meta_actions_daily', rows.flatMap((r) => actionRows(level, r, { fetchedAt })));
      for (const r of rows) if (!maxDate || r.date_start > maxDate) maxDate = r.date_start;
      count += rows.length;
    }
    setWatermark(db, accountId, report, maxDate ?? until, count);
    process.stdout.write(`  ${''.padEnd(16)} → ${count} rows\n`);
    total += count;
  }
  return total;
}

/* ----------------------------------------------------------------- page -- */

async function syncPage(client, db, upsert, page, args) {
  const fetchedAt = new Date().toISOString();
  const token = await client.pageToken(page.id);
  console.log(`\nPage ${page.id}  ${page.name ?? ''}`);
  upsert('meta_pages', [{
    page_id: page.id, name: page.name ?? null,
    ig_user_id: page.instagram_business_account?.id ?? null, last_synced_at: fetchedAt,
  }]);

  // Daily Page metrics
  const floor = addDays(iso(new Date()), -ORGANIC_HISTORY_DAYS);
  const { since, until } = windowFor(db, page.id, 'page_daily', { full: args.full, floor });
  process.stdout.write(`  ${'page_daily'.padEnd(16)} ${since} → ${until}\n`);
  let count = 0;
  let maxDate = null;
  const failedOnce = new Map();
  for (const w of chunkWindow(since, until, PAGE_WINDOW_DAYS)) {
    const metrics = PAGE_METRICS.filter((m) => !failedOnce.has(m));
    const { data, failed } = await client.metricsTolerant(`${page.id}/insights`, metrics, {
      token, params: { period: 'day', since: w.since, until: addDays(w.until, 1) },
    });
    for (const f of failed) failedOnce.set(f.metric, f);
    const rows = seriesRows(data, { idColumn: 'page_id', id: page.id, fetchedAt });
    count += upsert('meta_page_daily', rows);
    for (const r of rows) if (!maxDate || r.date > maxDate) maxDate = r.date;
  }
  recordMetricErrors(db, 'page', page.id, [...failedOnce.values()]);
  setWatermark(db, page.id, 'page_daily', maxDate ?? until, count);
  process.stdout.write(`  ${''.padEnd(16)} → ${count} rows\n`);

  // Posts, with lifetime insights for recent ones (all of them on --full)
  const postSince = args.full ? floor : addDays(iso(new Date()), -MEDIA_REFRESH_DAYS);
  const posts = await client.all(`${page.id}/posts`, {
    token,
    params: { fields: 'id,created_time,message,permalink_url,status_type', since: postSince, limit: 100 },
  });
  upsert('meta_page_posts', posts.map((p) => postToRow(p, { pageId: page.id, fetchedAt })));
  const postFailed = new Map();
  let insightRows = 0;
  for (const p of posts) {
    const metrics = POST_METRICS.filter((m) => !postFailed.has(m));
    const { data, failed } = await client.metricsTolerant(`${p.id}/insights`, metrics, { token });
    for (const f of failed) postFailed.set(f.metric, f);
    insightRows += upsert('meta_post_insights', lifetimeRows(data, { idColumn: 'post_id', id: p.id, fetchedAt }));
  }
  recordMetricErrors(db, 'post', page.id, [...postFailed.values()]);
  console.log(`  ${'posts'.padEnd(16)} ${posts.length} posts, ${insightRows} insight rows`);
  return count + posts.length + insightRows;
}

/* ------------------------------------------------------------ instagram -- */

async function syncInstagram(client, db, upsert, igUserId, { pageId, token }, args) {
  const fetchedAt = new Date().toISOString();
  const profile = await client.request(igUserId, {
    token, params: { fields: 'id,username,name,followers_count,media_count' },
  });
  console.log(`\nInstagram ${igUserId}  @${profile.username ?? '?'}`);
  upsert('meta_ig_accounts', [{
    ig_user_id: igUserId, username: profile.username ?? null, name: profile.name ?? null,
    followers_count: profile.followers_count ?? null, media_count: profile.media_count ?? null,
    page_id: pageId ?? null, last_synced_at: fetchedAt,
  }]);

  // Account metrics. follower_count only reaches back 30 days, whatever is asked.
  const floor = addDays(iso(new Date()), -ORGANIC_HISTORY_DAYS);
  const { since, until } = windowFor(db, igUserId, 'ig_daily', { full: args.full, floor });
  process.stdout.write(`  ${'ig_daily'.padEnd(16)} ${since} → ${until}\n`);
  const failedOnce = new Map();
  let count = 0;
  let maxDate = null;
  const track = (rows) => {
    count += upsert('meta_ig_daily', rows);
    for (const r of rows) if (!maxDate || r.date > maxDate) maxDate = r.date;
  };

  const series = IG_METRICS.filter((m) => m.mode === 'time_series').map((m) => m.name);
  for (const w of chunkWindow(since, until, IG_WINDOW_DAYS)) {
    const metrics = series.filter((m) => !failedOnce.has(m));
    const { data, failed } = await client.metricsTolerant(`${igUserId}/insights`, metrics, {
      token, params: { period: 'day', since: w.since, until: addDays(w.until, 1) },
    });
    for (const f of failed) failedOnce.set(f.metric, f);
    track(seriesRows(data, { idColumn: 'ig_user_id', id: igUserId, fetchedAt }));
  }

  // total_value metrics have no daily series: one call per day, all metrics at once.
  const totals = IG_METRICS.filter((m) => m.mode === 'total_value').map((m) => m.name);
  if (totals.length) {
    for (let d = since; d <= until; d = addDays(d, 1)) {
      const metrics = totals.filter((m) => !failedOnce.has(m));
      if (!metrics.length) break;
      const { data, failed } = await client.metricsTolerant(`${igUserId}/insights`, metrics, {
        token, params: { period: 'day', metric_type: 'total_value', since: d, until: addDays(d, 1) },
      });
      for (const f of failed) failedOnce.set(f.metric, f);
      track(totalValueRows(data, { id: igUserId, date: d, fetchedAt }));
    }
  }
  recordMetricErrors(db, 'instagram', igUserId, [...failedOnce.values()]);
  setWatermark(db, igUserId, 'ig_daily', maxDate ?? until, count);
  process.stdout.write(`  ${''.padEnd(16)} → ${count} rows\n`);

  // Media list (always whole: it is small), lifetime insights for recent items.
  const media = await client.all(`${igUserId}/media`, {
    token,
    params: { fields: 'id,timestamp,media_type,media_product_type,permalink,caption,like_count,comments_count', limit: 100 },
  });
  upsert('meta_ig_media', media.map((m) => mediaToRow(m, { igUserId, fetchedAt })));
  const cutoff = args.full ? '' : addDays(iso(new Date()), -MEDIA_REFRESH_DAYS);
  const mediaFailed = new Map();
  let insightRows = 0;
  for (const m of media.filter((x) => (x.timestamp ?? '').slice(0, 10) >= cutoff)) {
    const metrics = IG_MEDIA_METRICS.filter((x) => !mediaFailed.has(x));
    const { data, failed } = await client.metricsTolerant(`${m.id}/insights`, metrics, { token });
    for (const f of failed) mediaFailed.set(f.metric, f);
    insightRows += upsert('meta_ig_media_insights', lifetimeRows(data, { idColumn: 'media_id', id: m.id, fetchedAt }));
  }
  recordMetricErrors(db, 'ig_media', igUserId, [...mediaFailed.values()]);
  console.log(`  ${'media'.padEnd(16)} ${media.length} items, ${insightRows} insight rows`);
  return count + media.length + insightRows;
}

/* ----------------------------------------------------------------- main -- */

function parseArgs(argv) {
  const args = { full: false, verbose: false, account: null, reports: ['ads', 'page', 'instagram'] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--account') args.account = normaliseAdAccountId(argv[++i]);
    else if (a === '--reports') args.reports = parseList(argv[++i]);
  }
  return args;
}

function listing(label, items, fmt) {
  return `${label}:\n  ${items.length ? items.map(fmt).join('\n  ') : '(none)'}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new MetaClient({ verbose: args.verbose });

  const wantsAds = args.reports.includes('ads');
  const wantsPage = args.reports.includes('page');
  const wantsIg = args.reports.includes('instagram');

  const accounts = wantsAds ? await client.listAdAccounts() : [];
  const pages = wantsPage || wantsIg ? await client.listPages() : [];

  // Refuse rather than guess when nothing is allowlisted.
  const fmtAcct = (a) => `${normaliseAdAccountId(a.id).padEnd(18)} ${a.name ?? ''}`;
  const fmtPage = (p) => `${String(p.id).padEnd(18)} ${p.name ?? ''}`
    + (p.instagram_business_account?.id ? `  (Instagram ${p.instagram_business_account.id})` : '');
  const unset = [];
  if (wantsAds && !AD_ACCOUNTS.length) unset.push('META_AD_ACCOUNT_IDS');
  if ((wantsPage || wantsIg) && !PAGES.length && !IG_USERS.length) unset.push('META_PAGE_IDS');
  if (unset.length) {
    console.error(`${unset.join(' and ')} not set. Add the IDs that belong to this business to env.local.\n\n`
      + `${listing('Ad accounts this token can see', accounts, fmtAcct)}\n\n`
      + `${listing('Pages this token can see', pages, fmtPage)}`);
    process.exit(1);
  }

  const db = openDb();
  const upsert = makeUpserter(db);
  const started = Date.now();
  let total = 0;

  if (wantsAds) {
    const { targets, excluded, missing } = resolveTargets(AD_ACCOUNTS, accounts, normaliseAdAccountId);
    if (excluded.length) console.log(`   skipping ${excluded.length} ad account(s) not on the allowlist`);
    if (missing.length) console.log(`   ⚠︎ allowlisted but not visible to this token: ${missing.join(', ')}`);
    const chosen = targets.filter((a) => !args.account || normaliseAdAccountId(a.id) === args.account);
    console.log(`📣 Meta ads · ${chosen.length} account(s)${args.full ? ' · full pull' : ''}`);
    for (const a of chosen) total += await syncAds(client, db, upsert, a, args);
  }

  if (wantsPage || wantsIg) {
    const { targets, excluded, missing } = resolveTargets(PAGES, pages);
    if (excluded.length) console.log(`\n   skipping ${excluded.length} Page(s) not on the allowlist`);
    if (missing.length) console.log(`   ⚠︎ allowlisted Page(s) not visible to this token: ${missing.join(', ')}`);

    if (wantsPage) {
      console.log(`\n📄 Facebook Pages · ${targets.length}`);
      for (const p of targets) total += await syncPage(client, db, upsert, p, args);
    }

    if (wantsIg) {
      // Explicit IG ids win; otherwise each allowed Page's linked IG account.
      // IG insights are read with the linked Page's token.
      const igTargets = IG_USERS.length
        ? IG_USERS.map((id) => ({ id, page: targets.find((p) => p.instagram_business_account?.id === id) }))
        : targets.filter((p) => p.instagram_business_account?.id)
          .map((p) => ({ id: p.instagram_business_account.id, page: p }));
      console.log(`\n📸 Instagram · ${igTargets.length}`);
      for (const ig of igTargets) {
        const token = ig.page ? await client.pageToken(ig.page.id) : client.accessToken;
        total += await syncInstagram(client, db, upsert, ig.id, { pageId: ig.page?.id, token }, args);
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
