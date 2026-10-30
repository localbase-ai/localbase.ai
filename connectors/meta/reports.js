/**
 * What this connector pulls from Meta, and how each response becomes rows.
 *
 * Three surfaces, three shapes:
 *
 *   Ads        Marketing API insights, one row per object per day at three
 *              levels (campaign, ad set, ad), plus the objects themselves.
 *   Page       Page Insights, stored long (page, date, metric) because Meta
 *              retires Page metrics often enough that a wide table would need
 *              a migration every few months.
 *   Instagram  Account insights stored the same long way, plus the media list
 *              and lifetime insights per media item.
 *
 * Ad `actions` arrive as an array of {action_type, value}. They go to their own
 * table, one row per type, so any action can be queried without parsing JSON.
 * A handful that matter for lead-generating local businesses (leads, link
 * clicks, calls, messages) are also copied onto the daily rows as columns.
 *
 * Nothing here talks to the network; it is all pure so it can be tested offline.
 */

/** Meta restates recent days (late conversions, attribution); re-pull this far back. */
export const REVISION_DAYS = 28;

/** Windows longer than this go through an async report job instead of a GET. */
export const ASYNC_THRESHOLD_DAYS = 90;

/** Insights are retained for 37 months; asking earlier is an error. */
export const ADS_HISTORY_MONTHS = 37;

/** Page Insights accept at most ~93 days per request. */
export const PAGE_WINDOW_DAYS = 90;

/** Instagram account insights accept at most 30 days per request. */
export const IG_WINDOW_DAYS = 30;

/** How far back a --full run reaches for Page and Instagram insights. */
export const ORGANIC_HISTORY_DAYS = 730;

/** Incremental runs refresh lifetime insights for media/posts this recent. */
export const MEDIA_REFRESH_DAYS = 90;

/** Max length kept from a post message or caption. */
export const EXCERPT_LENGTH = 280;

export const LEVELS = ['campaign', 'adset', 'ad'];

export const INSIGHT_FIELDS = [
  'account_id', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'date_start', 'date_stop', 'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks',
  'ctr', 'cpc', 'cpm', 'frequency', 'actions', 'action_values', 'cost_per_action_type',
  'attribution_setting',
];

/**
 * Action types copied onto the daily rows. Everything Meta returns is still in
 * meta_actions_daily; these are just the ones worth not having to join for.
 * Call actions come from call ads / call buttons; which variant appears depends
 * on the ad format, so both are kept rather than summed (they are different
 * steps of the same call, and summing would double-count).
 */
export const HEADLINE_ACTIONS = {
  lead: 'leads',
  'offsite_conversion.fb_pixel_lead': 'pixel_leads',
  link_click: 'link_click_actions',
  'onsite_conversion.messaging_conversation_started_7d': 'messaging_starts',
  click_to_call_native_call_placed: 'calls_placed',
  click_to_call_call_confirm: 'calls_confirmed',
  video_view: 'video_views',
};

/**
 * Page metrics requested by default. Meta deprecated much of the Page
 * Insights catalogue in 2025 (the page_impressions family gave way to "views"
 * metrics), so any of these may be rejected for a given API version. A rejected
 * metric is logged to meta_metric_errors and skipped, never fatal. Override with
 * META_PAGE_METRICS (comma-separated).
 */
export const DEFAULT_PAGE_METRICS = [
  'page_media_view',
  'page_total_media_view_unique',
  'page_post_engagements',
  'page_follows',
  'page_daily_follows_unique',
  'page_views_total',
  'page_impressions_unique',
];

/** Lifetime metrics per Page post. Same tolerance. Override: META_POST_METRICS. */
export const DEFAULT_POST_METRICS = [
  'post_media_view',
  'post_total_media_view_unique',
  'post_impressions_unique',
  'post_clicks',
  'post_reactions_by_type_total',
];

/**
 * Instagram account metrics. Since Graph v22 most account metrics only come as
 * `metric_type=total_value` (one number per window), not as a daily series, so
 * those are requested one day at a time. `impressions` was removed in favour of
 * `views`. Override with META_IG_METRICS as name:mode pairs, e.g.
 * "reach:time_series,views:total_value".
 */
export const DEFAULT_IG_METRICS = [
  { name: 'reach', mode: 'time_series' },
  { name: 'follower_count', mode: 'time_series' },
  { name: 'views', mode: 'total_value' },
  { name: 'profile_views', mode: 'total_value' },
  { name: 'website_clicks', mode: 'total_value' },
  { name: 'accounts_engaged', mode: 'total_value' },
  { name: 'total_interactions', mode: 'total_value' },
];

/** Lifetime metrics per IG media item (`plays`/`impressions` are retired). Override: META_IG_MEDIA_METRICS. */
export const DEFAULT_IG_MEDIA_METRICS = [
  'reach', 'views', 'likes', 'comments', 'saved', 'shares', 'total_interactions',
];

/* ------------------------------------------------------------------ ids -- */

/** "act_123", "123" and " act_123 " all mean ad account 123. */
export function normaliseAdAccountId(id) {
  return String(id ?? '').trim().replace(/^act_/, '');
}

export function parseList(value) {
  return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseIgMetrics(value) {
  const items = parseList(value);
  if (!items.length) return DEFAULT_IG_METRICS;
  return items.map((item) => {
    const [name, mode = 'total_value'] = item.split(':').map((s) => s.trim());
    return { name, mode: mode === 'time_series' ? 'time_series' : 'total_value' };
  });
}

/**
 * Split what the token can see into what this workspace syncs.
 * `configured` empty → nothing is synced (the caller refuses and lists `visible`).
 */
export function resolveTargets(configured, visible, normalise = (x) => String(x)) {
  const wanted = configured.map(normalise);
  const visibleIds = new Set(visible.map((v) => normalise(v.id)));
  return {
    targets: visible.filter((v) => wanted.includes(normalise(v.id))),
    excluded: visible.filter((v) => !wanted.includes(normalise(v.id))),
    missing: wanted.filter((id) => !visibleIds.has(id)),
  };
}

/* ---------------------------------------------------------------- dates -- */

export const iso = (d) => d.toISOString().slice(0, 10);

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Inclusive [since, until] cut into chunks of at most `size` days. */
export function chunkWindow(since, until, size) {
  const out = [];
  let start = since;
  while (start <= until) {
    const end = addDays(start, size - 1);
    out.push({ since: start, until: end < until ? end : until });
    start = addDays(end, 1);
  }
  return out;
}

export function monthsAgo(n, from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(d.getUTCDate() + 1); // stay inside the retention boundary
  return iso(d);
}

/**
 * Page and IG daily values carry `end_time`, the END of the day they describe
 * (e.g. 2026-01-02T08:00:00+0000 for 2026-01-01 in Pacific time). Step back a
 * day to name the day itself.
 */
export function endTimeToDate(endTime) {
  if (!endTime) return null;
  const d = new Date(endTime);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}

/* --------------------------------------------------------------- values -- */

const num = (v) => (v == null || v === '' ? null : Number(v));

/**
 * Some metrics return an object (reactions by type, follows by source).
 * Store the sum as `value` and the object verbatim as `detail`.
 */
export function metricValue(raw) {
  if (raw && typeof raw === 'object') {
    const total = Object.values(raw).reduce((s, v) => s + (Number(v) || 0), 0);
    return { value: total, detail: JSON.stringify(raw) };
  }
  return { value: num(raw), detail: null };
}

/**
 * Graph answers an unknown or retired metric with code 100 (invalid
 * parameter). Code 100 also covers other bad parameters, which is why the
 * caller retries metrics one at a time before blaming any single one.
 */
export function isInvalidMetricError(err) {
  return err?.code === 100;
}

export function excerpt(text, max = EXCERPT_LENGTH) {
  if (text == null) return null;
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ------------------------------------------------------------- ads rows -- */

export function insightTable(level) {
  return `meta_${level}_daily`;
}

export function insightDdl(level) {
  const parents = {
    campaign: 'campaign_id TEXT, campaign_name TEXT,',
    adset: 'campaign_id TEXT, campaign_name TEXT, adset_id TEXT, adset_name TEXT,',
    ad: 'campaign_id TEXT, campaign_name TEXT, adset_id TEXT, adset_name TEXT, ad_id TEXT, ad_name TEXT,',
  }[level];
  return `CREATE TABLE IF NOT EXISTS ${insightTable(level)} (
    account_id TEXT, date TEXT, ${parents}
    spend REAL, impressions REAL, reach REAL, clicks REAL, inline_link_clicks REAL,
    ctr REAL, cpc REAL, cpm REAL, frequency REAL,
    ${Object.values(HEADLINE_ACTIONS).map((c) => `${c} REAL`).join(', ')},
    attribution_setting TEXT,
    fetched_at TEXT,
    PRIMARY KEY (account_id, date, ${level}_id)
  )`;
}

export const ACTIONS_DDL = `CREATE TABLE IF NOT EXISTS meta_actions_daily (
  account_id TEXT, level TEXT, object_id TEXT, date TEXT, action_type TEXT,
  value REAL, action_value REAL, cost_per_action REAL,
  fetched_at TEXT,
  PRIMARY KEY (level, object_id, date, action_type)
)`;

const byType = (list) => Object.fromEntries((list ?? []).map((a) => [a.action_type, num(a.value)]));

/** One insights row → the daily row for its level. */
export function insightToRow(level, r, { fetchedAt }) {
  const actions = byType(r.actions);
  const row = {
    account_id: normaliseAdAccountId(r.account_id),
    date: r.date_start,
    campaign_id: r.campaign_id ?? null,
    campaign_name: r.campaign_name ?? null,
    spend: num(r.spend),
    impressions: num(r.impressions),
    reach: num(r.reach),
    clicks: num(r.clicks),
    inline_link_clicks: num(r.inline_link_clicks),
    ctr: num(r.ctr),
    cpc: num(r.cpc),
    cpm: num(r.cpm),
    frequency: num(r.frequency),
    attribution_setting: r.attribution_setting ?? 'account default',
    fetched_at: fetchedAt,
  };
  if (level !== 'campaign') {
    row.adset_id = r.adset_id ?? null;
    row.adset_name = r.adset_name ?? null;
  }
  if (level === 'ad') {
    row.ad_id = r.ad_id ?? null;
    row.ad_name = r.ad_name ?? null;
  }
  for (const [type, col] of Object.entries(HEADLINE_ACTIONS)) row[col] = actions[type] ?? 0;
  return row;
}

/** One insights row → one meta_actions_daily row per action type. */
export function actionRows(level, r, { fetchedAt }) {
  const counts = byType(r.actions);
  const values = byType(r.action_values);
  const costs = byType(r.cost_per_action_type);
  const types = new Set([...Object.keys(counts), ...Object.keys(values), ...Object.keys(costs)]);
  return [...types].map((type) => ({
    account_id: normaliseAdAccountId(r.account_id),
    level,
    object_id: r[`${level}_id`],
    date: r.date_start,
    action_type: type,
    value: counts[type] ?? null,
    action_value: values[type] ?? null,
    cost_per_action: costs[type] ?? null,
    fetched_at: fetchedAt,
  }));
}

/* ------------------------------------------------------ object metadata -- */

export const OBJECT_FIELDS = {
  campaign: ['id', 'name', 'status', 'effective_status', 'objective', 'daily_budget',
    'lifetime_budget', 'created_time', 'updated_time'],
  adset: ['id', 'name', 'campaign_id', 'status', 'effective_status', 'optimization_goal',
    'daily_budget', 'lifetime_budget', 'created_time', 'updated_time'],
  ad: ['id', 'name', 'campaign_id', 'adset_id', 'status', 'effective_status',
    'created_time', 'updated_time'],
};

export const OBJECTS_DDL = `
CREATE TABLE IF NOT EXISTS meta_ad_accounts (
  account_id TEXT PRIMARY KEY, name TEXT, currency TEXT, timezone_name TEXT,
  account_status INTEGER, last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS meta_campaigns (
  campaign_id TEXT PRIMARY KEY, account_id TEXT, name TEXT, status TEXT, effective_status TEXT,
  objective TEXT, daily_budget_minor INTEGER, lifetime_budget_minor INTEGER,
  created_time TEXT, updated_time TEXT, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS meta_adsets (
  adset_id TEXT PRIMARY KEY, account_id TEXT, campaign_id TEXT, name TEXT, status TEXT,
  effective_status TEXT, optimization_goal TEXT, daily_budget_minor INTEGER,
  lifetime_budget_minor INTEGER, created_time TEXT, updated_time TEXT, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS meta_ads (
  ad_id TEXT PRIMARY KEY, account_id TEXT, campaign_id TEXT, adset_id TEXT, name TEXT,
  status TEXT, effective_status TEXT, created_time TEXT, updated_time TEXT, fetched_at TEXT
)`;

export const OBJECT_TABLE = { campaign: 'meta_campaigns', adset: 'meta_adsets', ad: 'meta_ads' };

/**
 * Budgets come back as strings in the currency's minor unit (cents for USD).
 * Stored as-is in *_minor columns; dividing by 100 is wrong for zero-decimal
 * currencies, so that is left to the query, which knows the currency.
 */
export function objectToRow(level, o, { accountId, fetchedAt }) {
  const row = {
    [`${level}_id`]: o.id,
    account_id: normaliseAdAccountId(accountId),
    name: o.name ?? null,
    status: o.status ?? null,
    effective_status: o.effective_status ?? null,
    created_time: o.created_time ?? null,
    updated_time: o.updated_time ?? null,
    fetched_at: fetchedAt,
  };
  if (level === 'campaign') row.objective = o.objective ?? null;
  if (level === 'adset') {
    row.campaign_id = o.campaign_id ?? null;
    row.optimization_goal = o.optimization_goal ?? null;
  }
  if (level === 'ad') {
    row.campaign_id = o.campaign_id ?? null;
    row.adset_id = o.adset_id ?? null;
  }
  if (level !== 'ad') {
    row.daily_budget_minor = num(o.daily_budget);
    row.lifetime_budget_minor = num(o.lifetime_budget);
  }
  return row;
}

/* ------------------------------------------------------------- organic -- */

export const ORGANIC_DDL = `
CREATE TABLE IF NOT EXISTS meta_pages (
  page_id TEXT PRIMARY KEY, name TEXT, ig_user_id TEXT, last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS meta_page_daily (
  page_id TEXT, date TEXT, metric TEXT, value REAL, detail TEXT, fetched_at TEXT,
  PRIMARY KEY (page_id, date, metric)
);
CREATE TABLE IF NOT EXISTS meta_page_posts (
  post_id TEXT PRIMARY KEY, page_id TEXT, created_time TEXT, message_excerpt TEXT,
  permalink_url TEXT, status_type TEXT, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS meta_post_insights (
  post_id TEXT, metric TEXT, value REAL, detail TEXT, fetched_at TEXT,
  PRIMARY KEY (post_id, metric)
);
CREATE TABLE IF NOT EXISTS meta_ig_accounts (
  ig_user_id TEXT PRIMARY KEY, username TEXT, name TEXT, followers_count INTEGER,
  media_count INTEGER, page_id TEXT, last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS meta_ig_daily (
  ig_user_id TEXT, date TEXT, metric TEXT, value REAL, detail TEXT, fetched_at TEXT,
  PRIMARY KEY (ig_user_id, date, metric)
);
CREATE TABLE IF NOT EXISTS meta_ig_media (
  media_id TEXT PRIMARY KEY, ig_user_id TEXT, timestamp TEXT, media_type TEXT,
  media_product_type TEXT, permalink TEXT, caption_excerpt TEXT, like_count INTEGER,
  comments_count INTEGER, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS meta_ig_media_insights (
  media_id TEXT, metric TEXT, value REAL, detail TEXT, fetched_at TEXT,
  PRIMARY KEY (media_id, metric)
);
CREATE TABLE IF NOT EXISTS meta_metric_errors (
  scope TEXT, object_id TEXT, metric TEXT, error TEXT, first_seen_at TEXT, last_seen_at TEXT,
  PRIMARY KEY (scope, object_id, metric)
)`;

/** A Page or IG time-series insights response → long rows. */
export function seriesRows(data, { idColumn, id, fetchedAt }) {
  const rows = [];
  for (const series of data ?? []) {
    for (const point of series.values ?? []) {
      const date = endTimeToDate(point.end_time);
      if (!date) continue;
      rows.push({ [idColumn]: id, date, metric: series.name, ...metricValue(point.value), fetched_at: fetchedAt });
    }
  }
  return rows;
}

/** An IG `metric_type=total_value` response for one day → long rows dated that day. */
export function totalValueRows(data, { id, date, fetchedAt }) {
  return (data ?? [])
    .filter((m) => m.total_value)
    .map((m) => ({ ig_user_id: id, date, metric: m.name, ...metricValue(m.total_value.value), fetched_at: fetchedAt }));
}

/** Lifetime insights for one post or media item → rows keyed by that item. */
export function lifetimeRows(data, { idColumn, id, fetchedAt }) {
  return (data ?? []).map((m) => {
    const raw = m.values?.[0]?.value ?? m.total_value?.value ?? null;
    return { [idColumn]: id, metric: m.name, ...metricValue(raw), fetched_at: fetchedAt };
  });
}

export function postToRow(p, { pageId, fetchedAt }) {
  return {
    post_id: p.id,
    page_id: pageId,
    created_time: p.created_time ?? null,
    message_excerpt: excerpt(p.message),
    permalink_url: p.permalink_url ?? null,
    status_type: p.status_type ?? null,
    fetched_at: fetchedAt,
  };
}

export function mediaToRow(m, { igUserId, fetchedAt }) {
  return {
    media_id: m.id,
    ig_user_id: igUserId,
    timestamp: m.timestamp ?? null,
    media_type: m.media_type ?? null,
    media_product_type: m.media_product_type ?? null,
    permalink: m.permalink ?? null,
    caption_excerpt: excerpt(m.caption),
    like_count: num(m.like_count),
    comments_count: num(m.comments_count),
    fetched_at: fetchedAt,
  };
}

/* ---------------------------------------------------------------- state -- */

export const STATE_DDL = `CREATE TABLE IF NOT EXISTS sync_state (
  object_id TEXT,
  report TEXT,
  watermark_date TEXT,
  last_run_at TEXT,
  last_row_count INTEGER,
  PRIMARY KEY (object_id, report)
)`;
