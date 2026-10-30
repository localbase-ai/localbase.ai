/**
 * What this connector pulls from GA4, and why these shapes.
 *
 * Unlike Search Console, GA4 does not truncate or anonymise its rows — every
 * report here reconciles with `ga_daily`. What it DOES do is reject incompatible
 * dimension/metric pairs outright, so each shape below was validated against the
 * live API before being committed rather than assumed from the docs.
 *
 * Every report carries `date`. GA4 retains data far longer than Search Console
 * and can backfill, so the urgency is lower — but a local table still means
 * joins against other local sources (CRM, Search Console, ads), which the API cannot do.
 */

/** GA4 returns dates as YYYYMMDD; stored as YYYY-MM-DD to join with everything else. */
export const normaliseDate = (v) =>
  (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v);

const CORE = ['sessions', 'totalUsers', 'engagedSessions', 'keyEvents'];

export const REPORTS = [
  {
    name: 'daily',
    table: 'ga_daily',
    dimensions: ['date'],
    metrics: ['sessions', 'totalUsers', 'newUsers', 'screenPageViews',
      'engagedSessions', 'engagementRate', 'averageSessionDuration', 'bounceRate', 'keyEvents'],
    description: 'Headline traffic per day.',
    ddl: `CREATE TABLE IF NOT EXISTS ga_daily (
      property TEXT, date TEXT,
      sessions REAL, total_users REAL, new_users REAL, screen_page_views REAL,
      engaged_sessions REAL, engagement_rate REAL, average_session_duration REAL,
      bounce_rate REAL, key_events REAL,
      fetched_at TEXT,
      PRIMARY KEY (property, date)
    )`,
  },
  {
    name: 'channel',
    table: 'ga_channel_daily',
    dimensions: ['date', 'sessionDefaultChannelGroup'],
    metrics: CORE,
    description: 'Default channel grouping per day — Direct, Organic Search, Referral and so on.',
    ddl: `CREATE TABLE IF NOT EXISTS ga_channel_daily (
      property TEXT, date TEXT, channel TEXT,
      sessions REAL, total_users REAL, engaged_sessions REAL, key_events REAL,
      fetched_at TEXT,
      PRIMARY KEY (property, date, channel)
    )`,
  },
  {
    name: 'source_medium',
    table: 'ga_source_medium_daily',
    dimensions: ['date', 'sessionSource', 'sessionMedium'],
    metrics: CORE,
    description: 'Session source and medium per day — the raw referral detail behind the channel grouping.',
    ddl: `CREATE TABLE IF NOT EXISTS ga_source_medium_daily (
      property TEXT, date TEXT, source TEXT, medium TEXT,
      sessions REAL, total_users REAL, engaged_sessions REAL, key_events REAL,
      fetched_at TEXT,
      PRIMARY KEY (property, date, source, medium)
    )`,
  },
  {
    name: 'campaign',
    table: 'ga_campaign_daily',
    dimensions: ['date', 'sessionCampaignName', 'sessionSource', 'sessionMedium'],
    metrics: ['sessions', 'totalUsers', 'keyEvents'],
    description: 'Campaign attribution per day. Source and medium are kept alongside because campaign names alone are often opaque ids.',
    ddl: `CREATE TABLE IF NOT EXISTS ga_campaign_daily (
      property TEXT, date TEXT, campaign TEXT, source TEXT, medium TEXT,
      sessions REAL, total_users REAL, key_events REAL,
      fetched_at TEXT,
      PRIMARY KEY (property, date, campaign, source, medium)
    )`,
  },
  {
    name: 'landing',
    table: 'ga_landing_daily',
    dimensions: ['date', 'landingPagePlusQueryString'],
    metrics: ['sessions', 'engagedSessions', 'bounceRate', 'keyEvents'],
    description: 'Landing pages per day — where sessions actually begin.',
    ddl: `CREATE TABLE IF NOT EXISTS ga_landing_daily (
      property TEXT, date TEXT, landing_page TEXT,
      sessions REAL, engaged_sessions REAL, bounce_rate REAL, key_events REAL,
      fetched_at TEXT,
      PRIMARY KEY (property, date, landing_page)
    )`,
  },
  {
    name: 'page',
    table: 'ga_page_daily',
    dimensions: ['date', 'pagePath'],
    metrics: ['screenPageViews', 'totalUsers', 'userEngagementDuration'],
    description: 'Pageviews per URL per day.',
    ddl: `CREATE TABLE IF NOT EXISTS ga_page_daily (
      property TEXT, date TEXT, page_path TEXT,
      screen_page_views REAL, total_users REAL, user_engagement_duration REAL,
      fetched_at TEXT,
      PRIMARY KEY (property, date, page_path)
    )`,
  },
  {
    name: 'geo',
    table: 'ga_geo_daily',
    dimensions: ['date', 'country', 'region', 'city'],
    metrics: ['sessions', 'totalUsers', 'engagedSessions'],
    description: 'Country, region and city per day. City matters for local businesses, where out-of-area traffic is noise.',
    ddl: `CREATE TABLE IF NOT EXISTS ga_geo_daily (
      property TEXT, date TEXT, country TEXT, region TEXT, city TEXT,
      sessions REAL, total_users REAL, engaged_sessions REAL,
      fetched_at TEXT,
      PRIMARY KEY (property, date, country, region, city)
    )`,
  },
  {
    name: 'device',
    table: 'ga_device_daily',
    dimensions: ['date', 'deviceCategory'],
    metrics: ['sessions', 'totalUsers', 'engagedSessions', 'bounceRate'],
    description: 'Device category per day.',
    ddl: `CREATE TABLE IF NOT EXISTS ga_device_daily (
      property TEXT, date TEXT, device TEXT,
      sessions REAL, total_users REAL, engaged_sessions REAL, bounce_rate REAL,
      fetched_at TEXT,
      PRIMARY KEY (property, date, device)
    )`,
  },
  {
    name: 'events',
    table: 'ga_event_daily',
    dimensions: ['date', 'eventName'],
    metrics: ['eventCount', 'totalUsers'],
    description: 'Event counts per day — what the site actually measures.',
    ddl: `CREATE TABLE IF NOT EXISTS ga_event_daily (
      property TEXT, date TEXT, event_name TEXT,
      event_count REAL, total_users REAL,
      fetched_at TEXT,
      PRIMARY KEY (property, date, event_name)
    )`,
  },
];

/** GA4 dimension/metric API name -> our column name. */
const COLUMN_FOR = {
  date: 'date',
  sessionDefaultChannelGroup: 'channel',
  sessionSource: 'source',
  sessionMedium: 'medium',
  sessionCampaignName: 'campaign',
  landingPagePlusQueryString: 'landing_page',
  pagePath: 'page_path',
  country: 'country',
  region: 'region',
  city: 'city',
  deviceCategory: 'device',
  eventName: 'event_name',
  sessions: 'sessions',
  totalUsers: 'total_users',
  newUsers: 'new_users',
  screenPageViews: 'screen_page_views',
  engagedSessions: 'engaged_sessions',
  engagementRate: 'engagement_rate',
  averageSessionDuration: 'average_session_duration',
  bounceRate: 'bounce_rate',
  keyEvents: 'key_events',
  eventCount: 'event_count',
  userEngagementDuration: 'user_engagement_duration',
};

/**
 * Map one API row. GA4 returns headers naming each column, so unlike Search
 * Console the mapping does not rely on request order — but the headers are used
 * anyway, so a future reordering cannot silently shift values into the wrong
 * columns.
 */
export function toRow(report, apiRow, { property, fetchedAt, dimensionHeaders, metricHeaders }) {
  const row = { property, fetched_at: fetchedAt };
  (dimensionHeaders ?? report.dimensions).forEach((name, i) => {
    const col = COLUMN_FOR[name];
    if (!col) return;
    const raw = apiRow.dimensionValues?.[i]?.value ?? null;
    row[col] = name === 'date' ? normaliseDate(raw) : raw;
  });
  (metricHeaders ?? report.metrics).forEach((name, i) => {
    const col = COLUMN_FOR[name];
    if (!col) return;
    const raw = apiRow.metricValues?.[i]?.value;
    row[col] = raw == null ? null : Number(raw);
  });
  return row;
}

export const PROPERTIES_DDL = `CREATE TABLE IF NOT EXISTS ga_properties (
  property TEXT PRIMARY KEY,
  display_name TEXT,
  account_name TEXT,
  property_type TEXT,
  create_time TEXT,
  time_zone TEXT,
  currency_code TEXT,
  industry_category TEXT,
  first_seen_at TEXT,
  last_synced_at TEXT
)`;

export const STATE_DDL = `CREATE TABLE IF NOT EXISTS sync_state (
  property TEXT,
  report TEXT,
  watermark_date TEXT,
  last_run_at TEXT,
  last_row_count INTEGER,
  PRIMARY KEY (property, report)
)`;

/**
 * GA4 keeps revising recent days for roughly 24-48 hours as late hits and
 * identity stitching land. Re-pull a trailing window rather than trusting the
 * watermark alone.
 */
export const FINALISATION_DAYS = 3;

/** Nothing before the property existed, and GA4 rejects dates before 2015. */
export const EARLIEST_DATE = '2015-08-14';
