/**
 * What this connector pulls from Google Ads, and why these shapes.
 *
 * Each report is one GAQL query. Its field list is the single source for three
 * things — the SELECT clause, the table's columns and the row mapper — so a
 * field cannot be queried without a column to land in, or the reverse.
 *
 * GAQL rejects incompatible fields outright rather than degrading: selecting
 * `metrics.impressions` alongside `segments.conversion_action` fails the whole
 * query, for instance. That is why conversions by action are their own report.
 * Adding a field means re-validating the query against the live API (Google's
 * Query Builder or `searchStream` with `LIMIT 1`).
 *
 * Response shape: REST returns camelCase JSON (`metrics.costMicros`) for the
 * snake_case GAQL field (`metrics.cost_micros`); int64 values arrive as
 * strings; and proto3 JSON omits fields at their default, so an absent metric
 * means zero. Impression-share metrics are the exception — absent there means
 * "not computed", which is stored as NULL rather than a misleading 0.
 */

/** `metrics.cost_micros` -> ['metrics', 'costMicros'] — the REST JSON path. */
export function jsonPath(gaqlField) {
  return gaqlField.split('.').map((part) => part.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()));
}

/**
 * Field kinds:
 *   text     string or enum, stored as-is
 *   int      int64 (arrives as a string); absent = 0
 *   real     double; absent = 0
 *   share    impression-share double; absent = NULL
 *   micros   money in millionths of the account currency; stored twice —
 *            `<col>_micros` INTEGER (exact) and `<col>` REAL (currency units)
 *   attr     an int64 attribute such as quality score; absent = NULL
 */
const SQL_TYPE = { text: 'TEXT', int: 'INTEGER', real: 'REAL', share: 'REAL', attr: 'INTEGER' };

const f = (column, field, kind = 'text') => ({ column, field, kind });

/** The headline metrics most reports share. */
const PERFORMANCE = [
  f('impressions', 'metrics.impressions', 'int'),
  f('clicks', 'metrics.clicks', 'int'),
  f('cost', 'metrics.cost_micros', 'micros'),
  f('conversions', 'metrics.conversions', 'real'),
  f('conversions_value', 'metrics.conversions_value', 'real'),
];

/** Calls placed from ads and call assets (Google forwarding numbers). */
const CALLS = [
  f('phone_calls', 'metrics.phone_calls', 'int'),
  f('phone_impressions', 'metrics.phone_impressions', 'int'),
];

export const REPORTS = [
  {
    name: 'customer',
    table: 'ads_customer_daily',
    resource: 'customer',
    dated: 'date',
    description: 'Account totals per day.',
    fields: [
      f('date', 'segments.date'),
      ...PERFORMANCE,
      f('all_conversions', 'metrics.all_conversions', 'real'),
      f('interactions', 'metrics.interactions', 'int'),
      ...CALLS,
    ],
    key: ['customer_id', 'date'],
  },
  {
    name: 'campaign',
    table: 'ads_campaign_daily',
    resource: 'campaign',
    dated: 'date',
    description: 'Campaign performance per day, with search impression share where Google computes it.',
    fields: [
      f('date', 'segments.date'),
      f('campaign_id', 'campaign.id'),
      f('campaign_name', 'campaign.name'),
      f('campaign_status', 'campaign.status'),
      f('channel_type', 'campaign.advertising_channel_type'),
      ...PERFORMANCE,
      f('all_conversions', 'metrics.all_conversions', 'real'),
      f('interactions', 'metrics.interactions', 'int'),
      ...CALLS,
      f('search_impression_share', 'metrics.search_impression_share', 'share'),
      f('search_top_impression_share', 'metrics.search_top_impression_share', 'share'),
      f('search_budget_lost_impression_share', 'metrics.search_budget_lost_impression_share', 'share'),
      f('search_rank_lost_impression_share', 'metrics.search_rank_lost_impression_share', 'share'),
    ],
    key: ['customer_id', 'date', 'campaign_id'],
  },
  {
    name: 'ad_group',
    table: 'ads_ad_group_daily',
    resource: 'ad_group',
    dated: 'date',
    description: 'Ad group performance per day.',
    fields: [
      f('date', 'segments.date'),
      f('campaign_id', 'campaign.id'),
      f('ad_group_id', 'ad_group.id'),
      f('ad_group_name', 'ad_group.name'),
      f('ad_group_status', 'ad_group.status'),
      ...PERFORMANCE,
      f('interactions', 'metrics.interactions', 'int'),
    ],
    key: ['customer_id', 'date', 'ad_group_id'],
  },
  {
    name: 'keyword',
    table: 'ads_keyword_daily',
    resource: 'keyword_view',
    dated: 'date',
    description: 'Keyword performance per day. quality_score is the CURRENT score on every row, not the score that day.',
    fields: [
      f('date', 'segments.date'),
      f('campaign_id', 'campaign.id'),
      f('ad_group_id', 'ad_group.id'),
      f('criterion_id', 'ad_group_criterion.criterion_id'),
      f('keyword', 'ad_group_criterion.keyword.text'),
      f('match_type', 'ad_group_criterion.keyword.match_type'),
      f('criterion_status', 'ad_group_criterion.status'),
      f('quality_score', 'ad_group_criterion.quality_info.quality_score', 'attr'),
      ...PERFORMANCE,
    ],
    key: ['customer_id', 'date', 'ad_group_id', 'criterion_id'],
  },
  {
    name: 'search_term',
    table: 'ads_search_term_daily',
    resource: 'search_term_view',
    dated: 'date',
    description: 'What people actually typed, per day. Google hides low-volume terms, so these do not sum to keyword totals.',
    fields: [
      f('date', 'segments.date'),
      f('campaign_id', 'campaign.id'),
      f('ad_group_id', 'ad_group.id'),
      f('search_term', 'search_term_view.search_term'),
      f('search_term_status', 'search_term_view.status'),
      ...PERFORMANCE,
    ],
    key: ['customer_id', 'date', 'ad_group_id', 'search_term'],
  },
  {
    name: 'conversion',
    table: 'ads_conversion_daily',
    resource: 'campaign',
    dated: 'date',
    description: 'Conversions per campaign per conversion action per day. Join ads_conversion_actions on conversion_action to tell calls from forms.',
    fields: [
      f('date', 'segments.date'),
      f('campaign_id', 'campaign.id'),
      f('conversion_action', 'segments.conversion_action'),
      f('conversion_action_name', 'segments.conversion_action_name'),
      f('conversion_action_category', 'segments.conversion_action_category'),
      f('conversions', 'metrics.conversions', 'real'),
      f('conversions_value', 'metrics.conversions_value', 'real'),
      f('all_conversions', 'metrics.all_conversions', 'real'),
      f('all_conversions_value', 'metrics.all_conversions_value', 'real'),
    ],
    key: ['customer_id', 'date', 'campaign_id', 'conversion_action'],
  },
  {
    name: 'geo',
    table: 'ads_geo_daily',
    resource: 'geographic_view',
    dated: 'date',
    description: 'Performance by city per day. Location ids resolve to names through ads_geo_targets.',
    fields: [
      f('date', 'segments.date'),
      f('campaign_id', 'campaign.id'),
      f('location_type', 'geographic_view.location_type'),
      f('country_criterion_id', 'geographic_view.country_criterion_id'),
      f('geo_target_city', 'segments.geo_target_city'),
      ...PERFORMANCE,
    ],
    key: ['customer_id', 'date', 'campaign_id', 'location_type', 'country_criterion_id', 'geo_target_city'],
  },
  {
    name: 'calls',
    table: 'ads_calls',
    resource: 'call_view',
    dated: 'call',
    description: 'One row per call through a Google forwarding number. Google exposes area code and country, never the full caller number.',
    fields: [
      f('call_id', 'call_view.resource_name'),
      f('campaign_id', 'campaign.id'),
      f('ad_group_id', 'ad_group.id'),
      f('start_call_date_time', 'call_view.start_call_date_time'),
      f('end_call_date_time', 'call_view.end_call_date_time'),
      f('call_duration_seconds', 'call_view.call_duration_seconds', 'int'),
      f('call_status', 'call_view.call_status'),
      f('call_type', 'call_view.type'),
      f('call_tracking_display_location', 'call_view.call_tracking_display_location'),
      f('caller_area_code', 'call_view.caller_area_code'),
      f('caller_country_code', 'call_view.caller_country_code'),
    ],
    key: ['customer_id', 'call_id'],
  },
  {
    name: 'campaigns',
    table: 'ads_campaigns',
    resource: 'campaign',
    dated: null,
    description: 'Campaign settings, re-read whole each run.',
    fields: [
      f('campaign_id', 'campaign.id'),
      f('campaign_name', 'campaign.name'),
      f('campaign_status', 'campaign.status'),
      f('channel_type', 'campaign.advertising_channel_type'),
      f('channel_sub_type', 'campaign.advertising_channel_sub_type'),
      f('bidding_strategy_type', 'campaign.bidding_strategy_type'),
      f('start_date', 'campaign.start_date'),
      f('end_date', 'campaign.end_date'),
      f('budget', 'campaign_budget.amount_micros', 'micros'),
    ],
    key: ['customer_id', 'campaign_id'],
  },
  {
    name: 'ad_groups',
    table: 'ads_ad_groups',
    resource: 'ad_group',
    dated: null,
    description: 'Ad group settings, re-read whole each run.',
    fields: [
      f('ad_group_id', 'ad_group.id'),
      f('campaign_id', 'campaign.id'),
      f('ad_group_name', 'ad_group.name'),
      f('ad_group_status', 'ad_group.status'),
      f('ad_group_type', 'ad_group.type'),
    ],
    key: ['customer_id', 'ad_group_id'],
  },
  {
    name: 'conversion_actions',
    table: 'ads_conversion_actions',
    resource: 'conversion_action',
    dated: null,
    description: 'Conversion action definitions. type says what kind of call a call conversion is (AD_CALL, WEBSITE_CALL, CLICK_TO_CALL).',
    fields: [
      f('conversion_action', 'conversion_action.resource_name'),
      f('conversion_action_id', 'conversion_action.id'),
      f('name', 'conversion_action.name'),
      f('type', 'conversion_action.type'),
      f('category', 'conversion_action.category'),
      f('status', 'conversion_action.status'),
      f('primary_for_goal', 'conversion_action.primary_for_goal'),
      f('counting_type', 'conversion_action.counting_type'),
    ],
    key: ['customer_id', 'conversion_action'],
  },
];

/** Columns a field occupies — two for money, one for everything else. */
function columnsOf(field) {
  if (field.kind === 'micros') {
    return [[`${field.column}_micros`, 'INTEGER'], [field.column, 'REAL']];
  }
  return [[field.column, SQL_TYPE[field.kind]]];
}

export function ddlFor(report) {
  const cols = [['customer_id', 'TEXT'], ...report.fields.flatMap(columnsOf), ['fetched_at', 'TEXT']];
  return `CREATE TABLE IF NOT EXISTS ${report.table} (
    ${cols.map(([c, t]) => `${c} ${t}`).join(',\n    ')},
    PRIMARY KEY (${report.key.join(', ')})
  )`;
}

/**
 * The GAQL for one report over one window. Dates are inclusive on both ends.
 * call_view is not segmented by date, so it filters on the call's start time.
 */
export function queryFor(report, { startDate, endDate } = {}) {
  let q = `SELECT ${report.fields.map((x) => x.field).join(', ')} FROM ${report.resource}`;
  if (report.dated === 'date') {
    q += ` WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`;
  } else if (report.dated === 'call') {
    q += ` WHERE call_view.start_call_date_time >= '${startDate} 00:00:00'`
      + ` AND call_view.start_call_date_time <= '${endDate} 23:59:59'`;
  }
  return q;
}

function dig(obj, path) {
  let v = obj;
  for (const p of path) {
    if (v == null) return undefined;
    v = v[p];
  }
  return v;
}

/** The last path segment of a resource name: `customers/1/callViews/987` -> `987`. */
const lastSegment = (v) => (typeof v === 'string' ? v.split('/').pop() : v);

/** Map one searchStream result onto a table row. */
export function toRow(report, result, { customerId, fetchedAt }) {
  const row = { customer_id: String(customerId), fetched_at: fetchedAt };
  for (const field of report.fields) {
    const raw = dig(result, jsonPath(field.field));
    switch (field.kind) {
      case 'int':
      case 'real':
        row[field.column] = raw == null ? 0 : Number(raw);
        break;
      case 'share':
      case 'attr':
        row[field.column] = raw == null ? null : Number(raw);
        break;
      case 'micros': {
        const micros = raw == null ? 0 : Number(raw);
        row[`${field.column}_micros`] = micros;
        row[field.column] = micros / 1e6;
        break;
      }
      default:
        row[field.column] = raw == null ? null : String(raw);
    }
  }
  if (report.name === 'calls' && row.call_id) row.call_id = lastSegment(row.call_id);
  // SQLite treats NULLs in a composite primary key as distinct, so a NULL key
  // part would insert a duplicate on every re-pull instead of upserting.
  for (const k of report.key) if (row[k] == null) row[k] = '';
  return row;
}

export const CUSTOMERS_DDL = `CREATE TABLE IF NOT EXISTS ads_customers (
  customer_id TEXT PRIMARY KEY,
  descriptive_name TEXT,
  currency_code TEXT,
  time_zone TEXT,
  is_manager TEXT,
  is_test_account TEXT,
  first_seen_at TEXT,
  last_synced_at TEXT
)`;

export const GEO_TARGETS_DDL = `CREATE TABLE IF NOT EXISTS ads_geo_targets (
  geo_target TEXT PRIMARY KEY,
  name TEXT,
  canonical_name TEXT,
  target_type TEXT,
  country_code TEXT
)`;

export const STATE_DDL = `CREATE TABLE IF NOT EXISTS sync_state (
  customer_id TEXT,
  report TEXT,
  watermark_date TEXT,
  last_run_at TEXT,
  last_row_count INTEGER,
  PRIMARY KEY (customer_id, report)
)`;

/**
 * Google Ads restates recent days: clicks and cost settle within a few days,
 * but conversions keep landing for the length of each action's conversion
 * window (30 days by default, up to 90). Incremental runs re-pull this many
 * trailing days and upsert over them. Raise it if the account uses longer
 * conversion windows.
 */
export const REVISION_DAYS = 30;

/** How far back a full pull reaches. Override with GOOGLE_ADS_FULL_DAYS. */
export const FULL_DAYS = 1095;

/** Long windows are split so one response never carries years of search terms. */
export const CHUNK_DAYS = 90;
