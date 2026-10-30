/**
 * What this connector stores from the Merchant API, and how API objects map to rows.
 *
 * Two grains, kept apart on purpose:
 *
 *   - Products are a SNAPSHOT. The API answers "what is in the feed now", with
 *     no history, so every run re-fetches the whole catalogue. A product that
 *     stops appearing is stamped `disappeared_at`, never deleted — the local
 *     table is the only record it ever existed. Its destination statuses and
 *     item-level issues are child snapshots, replaced wholesale per account.
 *   - Performance is DAILY. `product_performance_view` reports clicks and
 *     impressions per offer per day; recent days are revised, so incremental
 *     runs re-pull a trailing window and upsert over it.
 *
 * Money arrives as `{ amountMicros, currencyCode }`; stored as a REAL amount
 * plus a currency column.
 */

/** Days re-pulled on every incremental performance run. */
export const FINALISATION_DAYS = 3;
/** How far back a --full performance pull reaches. */
export const FULL_LOOKBACK_DAYS = 365;

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Window for daily performance: the watermark minus the revision window, or
 * the full lookback on a first or --full run. Never earlier than the lookback.
 */
export function performanceWindow(mark, full, now = new Date()) {
  const today = iso(now);
  const floorDate = new Date(now);
  floorDate.setUTCDate(floorDate.getUTCDate() - FULL_LOOKBACK_DAYS);
  const floor = iso(floorDate);
  if (full || !mark) return { startDate: floor, endDate: today };
  const from = new Date(`${mark}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - FINALISATION_DAYS);
  return { startDate: iso(from) < floor ? floor : iso(from), endDate: today };
}

export const micros = (m) => (m?.amountMicros == null ? null : Number(m.amountMicros) / 1e6);

/** Merchant API dates are `{ year, month, day }`; stored as YYYY-MM-DD. */
export const normaliseDate = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
};

const num = (v) => (v == null || v === '' ? null : Number(v));
const list = (v) => (Array.isArray(v) && v.length ? v.join(',') : null);

export const ACCOUNTS_DDL = `CREATE TABLE IF NOT EXISTS mc_accounts (
  account_id TEXT PRIMARY KEY,
  account_name TEXT,
  time_zone TEXT,
  language_code TEXT,
  test_account INTEGER,
  first_seen_at TEXT,
  last_synced_at TEXT
)`;

export const PRODUCTS_DDL = `CREATE TABLE IF NOT EXISTS mc_products (
  account_id TEXT,
  product_name TEXT,            -- accounts/{a}/products/{p}, the API's stable id
  offer_id TEXT,
  content_language TEXT,
  feed_label TEXT,
  channel TEXT,                 -- ONLINE / LOCAL (derived from legacyLocal on v1)
  data_source TEXT,
  title TEXT,
  brand TEXT,
  link TEXT,
  has_image INTEGER,
  price REAL,
  sale_price REAL,
  currency TEXT,
  availability TEXT,
  condition TEXT,
  product_types TEXT,
  google_product_category TEXT,
  custom_label_0 TEXT, custom_label_1 TEXT, custom_label_2 TEXT,
  custom_label_3 TEXT, custom_label_4 TEXT,
  gtin TEXT,
  mpn TEXT,
  creation_date TEXT,
  last_update_date TEXT,
  google_expiration_date TEXT,
  issue_count INTEGER,
  disapproved_destinations INTEGER,
  first_seen_at TEXT,
  last_seen_at TEXT,
  disappeared_at TEXT,
  raw_json TEXT,
  PRIMARY KEY (account_id, product_name)
)`;

export const DESTINATIONS_DDL = `CREATE TABLE IF NOT EXISTS mc_product_destinations (
  account_id TEXT,
  product_name TEXT,
  reporting_context TEXT,       -- SHOPPING_ADS, FREE_LISTINGS, ...
  approved_countries TEXT,
  pending_countries TEXT,
  disapproved_countries TEXT,
  fetched_at TEXT,
  PRIMARY KEY (account_id, product_name, reporting_context)
)`;

export const ISSUES_DDL = `CREATE TABLE IF NOT EXISTS mc_product_issues (
  account_id TEXT,
  product_name TEXT,
  offer_id TEXT,
  code TEXT,
  severity TEXT,                -- NOT_IMPACTED / DEMOTED / DISAPPROVED
  resolution TEXT,              -- MERCHANT_ACTION / PENDING_PROCESSING
  attribute TEXT,
  reporting_context TEXT,
  description TEXT,
  detail TEXT,
  documentation TEXT,
  applicable_countries TEXT,
  fetched_at TEXT
)`;

export const ACCOUNT_ISSUES_DDL = `CREATE TABLE IF NOT EXISTS mc_account_issues (
  account_id TEXT,
  issue_name TEXT,
  title TEXT,
  severity TEXT,
  impacted_destinations TEXT,   -- JSON
  documentation_uri TEXT,
  fetched_at TEXT,
  PRIMARY KEY (account_id, issue_name)
)`;

export const PERFORMANCE_DDL = `CREATE TABLE IF NOT EXISTS mc_performance_daily (
  account_id TEXT,
  date TEXT,
  offer_id TEXT,
  marketing_method TEXT,        -- ORGANIC (free listings) / ADS (Shopping ads)
  title TEXT,
  clicks REAL,
  impressions REAL,
  click_through_rate REAL,
  conversions REAL,
  conversion_value REAL,
  currency TEXT,
  fetched_at TEXT,
  PRIMARY KEY (account_id, date, offer_id, marketing_method)
)`;

export const STATE_DDL = `CREATE TABLE IF NOT EXISTS sync_state (
  account_id TEXT,
  report TEXT,
  watermark_date TEXT,
  last_run_at TEXT,
  last_row_count INTEGER,
  PRIMARY KEY (account_id, report)
)`;

export const ALL_DDL = [ACCOUNTS_DDL, PRODUCTS_DDL, DESTINATIONS_DDL, ISSUES_DDL,
  ACCOUNT_ISSUES_DDL, PERFORMANCE_DDL, STATE_DDL];

/** The Merchant Query Language for one window of daily performance. */
export function performanceQuery(startDate, endDate) {
  return 'SELECT date, offer_id, title, marketing_method, clicks, impressions, '
    + 'click_through_rate, conversions, conversion_value '
    + 'FROM product_performance_view '
    + `WHERE date BETWEEN '${startDate}' AND '${endDate}'`;
}

/**
 * Product → { product, destinations, issues }.
 *
 * v1 nests attributes under `productAttributes`; v1beta used `attributes` and
 * a `channel` field that v1 replaced with `legacyLocal`. Both are read so a
 * version override in env.local does not silently blank the table.
 */
export function productToRows(p, { accountId, seenAt }) {
  const a = p.productAttributes ?? p.attributes ?? {};
  const status = p.productStatus ?? {};
  const issues = status.itemLevelIssues ?? [];
  const destinations = status.destinationStatuses ?? [];
  const productName = p.name;
  const channel = p.channel ?? (p.legacyLocal ? 'LOCAL' : 'ONLINE');
  const gtin = Array.isArray(a.gtins) ? a.gtins.join(',') : (a.gtin ?? null);

  const product = {
    account_id: accountId,
    product_name: productName,
    offer_id: p.offerId ?? null,
    content_language: p.contentLanguage ?? null,
    feed_label: p.feedLabel ?? null,
    channel,
    data_source: p.dataSource ?? null,
    title: a.title ?? null,
    brand: a.brand ?? null,
    link: a.link ?? null,
    has_image: a.imageLink ? 1 : 0,
    price: micros(a.price),
    sale_price: micros(a.salePrice),
    currency: a.price?.currencyCode ?? a.salePrice?.currencyCode ?? null,
    availability: a.availability ?? null,
    condition: a.condition ?? null,
    product_types: list(a.productTypes),
    google_product_category: a.googleProductCategory ?? null,
    custom_label_0: a.customLabel0 ?? null,
    custom_label_1: a.customLabel1 ?? null,
    custom_label_2: a.customLabel2 ?? null,
    custom_label_3: a.customLabel3 ?? null,
    custom_label_4: a.customLabel4 ?? null,
    gtin,
    mpn: a.mpn ?? null,
    creation_date: status.creationDate ?? null,
    last_update_date: status.lastUpdateDate ?? null,
    google_expiration_date: status.googleExpirationDate ?? null,
    issue_count: issues.length,
    disapproved_destinations: destinations.filter((d) => (d.disapprovedCountries ?? []).length).length,
    first_seen_at: seenAt,
    last_seen_at: seenAt,
    disappeared_at: null,
    raw_json: JSON.stringify(p),
  };

  return {
    product,
    destinations: destinations.map((d) => ({
      account_id: accountId,
      product_name: productName,
      reporting_context: d.reportingContext ?? d.destination ?? null,
      approved_countries: list(d.approvedCountries),
      pending_countries: list(d.pendingCountries),
      disapproved_countries: list(d.disapprovedCountries),
      fetched_at: seenAt,
    })),
    issues: issues.map((i) => ({
      account_id: accountId,
      product_name: productName,
      offer_id: p.offerId ?? null,
      code: i.code ?? null,
      severity: i.severity ?? null,
      resolution: i.resolution ?? null,
      attribute: i.attribute ?? null,
      reporting_context: i.reportingContext ?? i.destination ?? null,
      description: i.description ?? null,
      detail: i.detail ?? null,
      documentation: i.documentation ?? null,
      applicable_countries: list(i.applicableCountries),
      fetched_at: seenAt,
    })),
  };
}

/** One reports:search result → a mc_performance_daily row. */
export function performanceToRow(result, { accountId, fetchedAt }) {
  const v = result.productPerformanceView ?? {};
  return {
    account_id: accountId,
    date: normaliseDate(v.date),
    offer_id: v.offerId ?? '',
    marketing_method: v.marketingMethod ?? '',
    title: v.title ?? null,
    clicks: num(v.clicks),
    impressions: num(v.impressions),
    click_through_rate: num(v.clickThroughRate),
    conversions: num(v.conversions),
    conversion_value: micros(v.conversionValue),
    currency: v.conversionValue?.currencyCode ?? null,
    fetched_at: fetchedAt,
  };
}

export function accountIssueToRow(i, { accountId, fetchedAt }) {
  return {
    account_id: accountId,
    issue_name: i.name ?? i.title ?? '',
    title: i.title ?? null,
    severity: i.severity ?? null,
    impacted_destinations: i.impactedDestinations ? JSON.stringify(i.impactedDestinations) : null,
    documentation_uri: i.documentationUri ?? null,
    fetched_at: fetchedAt,
  };
}
