/**
 * What this connector pulls, and why it is split this way.
 *
 * Search Console does not return a full cube. The API "does not guarantee to
 * return all data rows but rather top ones", and the more dimensions you ask
 * for at once the more aggressively it truncates and the more rows fall below
 * the anonymisation threshold. Asking for date x query x page x country x
 * device in one call produces a heavily sampled slice that reconciles with
 * nothing.
 *
 * So each report is a separate, deliberately shallow query. Totals come from
 * the date-only report — which IS complete — and the dimensional reports are
 * used for composition, not for totals. They will not sum to the headline, and
 * that is a property of the source, not a bug here.
 *
 * Every report carries `date` so rows accumulate into a time series. That is
 * the entire point: Search Console deletes performance data after 16 months,
 * permanently, so anything not copied out is gone.
 */

/** Dimension sets, one table each. */
export const REPORTS = [
  {
    name: 'daily',
    table: 'gsc_daily',
    dimensions: ['date'],
    description: 'Headline clicks/impressions/CTR/position per day. Complete — use for totals.',
    ddl: `CREATE TABLE IF NOT EXISTS gsc_daily (
      site TEXT, search_type TEXT, date TEXT,
      clicks REAL, impressions REAL, ctr REAL, position REAL,
      fetched_at TEXT,
      PRIMARY KEY (site, search_type, date)
    )`,
  },
  {
    name: 'query',
    table: 'gsc_query_daily',
    dimensions: ['date', 'query'],
    description: 'Per-query performance per day. Truncated and anonymised by Google.',
    ddl: `CREATE TABLE IF NOT EXISTS gsc_query_daily (
      site TEXT, search_type TEXT, date TEXT, query TEXT,
      clicks REAL, impressions REAL, ctr REAL, position REAL,
      fetched_at TEXT,
      PRIMARY KEY (site, search_type, date, query)
    )`,
  },
  {
    name: 'page',
    table: 'gsc_page_daily',
    dimensions: ['date', 'page'],
    description: 'Per-URL performance per day.',
    ddl: `CREATE TABLE IF NOT EXISTS gsc_page_daily (
      site TEXT, search_type TEXT, date TEXT, page TEXT,
      clicks REAL, impressions REAL, ctr REAL, position REAL,
      fetched_at TEXT,
      PRIMARY KEY (site, search_type, date, page)
    )`,
  },
  {
    name: 'geo_device',
    table: 'gsc_geo_device_daily',
    dimensions: ['date', 'country', 'device'],
    description: 'Country x device per day — how much traffic is actually local.',
    ddl: `CREATE TABLE IF NOT EXISTS gsc_geo_device_daily (
      site TEXT, search_type TEXT, date TEXT, country TEXT, device TEXT,
      clicks REAL, impressions REAL, ctr REAL, position REAL,
      fetched_at TEXT,
      PRIMARY KEY (site, search_type, date, country, device)
    )`,
  },
  {
    name: 'appearance',
    table: 'gsc_appearance',
    dimensions: ['searchAppearance'],
    // The API rejects searchAppearance grouped with ANY other dimension,
    // including date: "Cannot group by search appearance dimension together
    // with another dimension." So this one cannot be a daily series. It is
    // stored as a snapshot over the requested window instead, which still
    // trends across runs — just coarsely.
    standalone: true,
    description: 'Rich-result appearance types, aggregated over the synced window (cannot be grouped by date).',
    ddl: `CREATE TABLE IF NOT EXISTS gsc_appearance (
      site TEXT, search_type TEXT,
      period_start TEXT, period_end TEXT, search_appearance TEXT,
      clicks REAL, impressions REAL, ctr REAL, position REAL,
      fetched_at TEXT,
      PRIMARY KEY (site, search_type, period_start, period_end, search_appearance)
    )`,
  },
];

/** Column name in our table for each API dimension. */
const COLUMN_FOR = {
  date: 'date',
  query: 'query',
  page: 'page',
  country: 'country',
  device: 'device',
  searchAppearance: 'search_appearance',
};

/**
 * Turn one API row into a table row. `keys` positionally matches the requested
 * dimensions, which is the only thing tying them together — the response does
 * not name them.
 */
export function toRow(report, apiRow, { site, searchType, fetchedAt, window = null }) {
  const row = { site, search_type: searchType, fetched_at: fetchedAt };
  // A standalone report has no date of its own, so the requested window is what
  // identifies the row.
  if (report.standalone) {
    row.period_start = window?.startDate ?? null;
    row.period_end = window?.endDate ?? null;
  }
  report.dimensions.forEach((dim, i) => {
    row[COLUMN_FOR[dim]] = apiRow.keys?.[i] ?? null;
  });
  row.clicks = apiRow.clicks ?? 0;
  row.impressions = apiRow.impressions ?? 0;
  row.ctr = apiRow.ctr ?? 0;
  row.position = apiRow.position ?? null;
  return row;
}

export const SITES_DDL = `CREATE TABLE IF NOT EXISTS gsc_sites (
  site TEXT PRIMARY KEY,
  permission_level TEXT,
  first_seen_at TEXT,
  last_synced_at TEXT
)`;

export const STATE_DDL = `CREATE TABLE IF NOT EXISTS sync_state (
  site TEXT,
  report TEXT,
  search_type TEXT,
  watermark_date TEXT,
  last_run_at TEXT,
  last_row_count INTEGER,
  PRIMARY KEY (site, report, search_type)
)`;

/**
 * Search types are separate datasets, not a filter over one. `web` is the
 * default and the only one most sites have; the rest are pulled only if asked
 * for, since each multiplies the request count.
 */
export const DEFAULT_SEARCH_TYPES = ['web'];
export const ALL_SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'];

/**
 * Search Console finalises data over roughly two to three days, and rows keep
 * moving during that window. Re-pulling a trailing window on every run is
 * cheaper and more correct than trusting a high-water mark alone.
 */
export const FINALISATION_DAYS = 4;

/** The API exposes nothing older than 16 months. */
export const MAX_LOOKBACK_DAYS = 16 * 30;
