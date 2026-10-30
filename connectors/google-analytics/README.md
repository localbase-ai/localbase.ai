# Google Analytics 4 connector

Syncs GA4 reports into `data/google-analytics/ga.db`, so traffic can be joined
locally with ads, calls, orders and CRM data — which no single API does for you.

## Setup

### 1. A Google OAuth client (shared by every Google connector)

Do this once per workspace; Google Ads and Merchant Center reuse it.

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a
   project and enable the APIs you need. For GA4:

   ```bash
   gcloud services enable analyticsdata.googleapis.com analyticsadmin.googleapis.com
   ```

   (`analyticshub.googleapis.com` is **not** one of them — that is an unrelated
   BigQuery data-sharing service with a similar name.)
2. *APIs & Services → OAuth consent screen*: configure it. While the app is in
   **Testing**, add the Google account you will sign in with as a test user.
   Refresh tokens from a Testing-mode app expire after 7 days; publish the app
   (it can stay unverified for your own use) to keep them.
3. *APIs & Services → Credentials → Create credentials → OAuth client ID →
   Desktop app*. Download the JSON and save it as
   `data/google/oauth-client.json` (or point `GOOGLE_OAUTH_CLIENT_FILE` at it).
   `data/` is gitignored.

Every Google connector shares that client but holds its **own token**
(`data/<connector>/tokens.json`), scoped to its own product, so a leaked token
reads one product rather than everything the account can reach.

### 2. Authorize

```bash
node connectors/google-analytics/authorize.js          # opens the browser
node connectors/google-analytics/authorize.js --manual # paste the redirect URL instead
```

Requests one scope, `analytics.readonly`, and prints every GA4 property the
account can see.

### 3. Choose properties

The account can usually see more than one business's properties. Syncing only
runs against an explicit allowlist in `env.local`:

```bash
GA4_PROPERTIES=123456789            # comma-separated for more than one
```

### 4. Sync

```bash
node connectors/google-analytics/sync.js --full                 # from property creation
node connectors/google-analytics/sync.js                        # incremental
node connectors/google-analytics/sync.js --property 123456789
node connectors/google-analytics/sync.js --reports daily,channel
node connectors/google-analytics/sync.js --verbose              # shows remaining quota
```

Incremental runs re-pull a trailing window, because GA4 revises recent days.

## What gets synced

Nine tables, all keyed on `(property, date, …)`:

| Table | Dimensions |
|---|---|
| `ga_daily` | date — sessions, users, new users, pageviews, engagement, bounce, key events |
| `ga_channel_daily` | date, default channel group |
| `ga_source_medium_daily` | date, source, medium |
| `ga_campaign_daily` | date, campaign, source, medium |
| `ga_landing_daily` | date, landing page |
| `ga_page_daily` | date, page path |
| `ga_geo_daily` | date, country, region, city |
| `ga_device_daily` | date, device category |
| `ga_event_daily` | date, event name |
| `ga_properties` | property metadata — creation time, timezone, currency, industry |

Every shape was validated against the live API before being committed. GA4
rejects incompatible dimension/metric pairs outright rather than degrading, so
adding a dimension means re-validating — `runReport` with `limit: 1` is enough.

## How GA4 behaves

**Rows are complete.** GA4 does not truncate or anonymise, so the dimensional
tables reconcile with `ga_daily`.

**Pagination has a real end.** `runReport` returns `rowCount`, the true total,
so paging runs until offset covers it rather than inferring from a short page.

**Quota is observable.** Requests set `returnPropertyQuota`, and the client logs
the tightest remaining bucket. GA4 meters several at once — tokens per day, per
hour, concurrent requests — and the binding one is whichever is nearest
exhaustion. Search Console exposes nothing equivalent.

**Dates need normalising.** GA4 returns `YYYYMMDD`; stored as `YYYY-MM-DD` so it
joins with other sources without casting.


## Caveats

- **Timezone changes are not retroactive.** If a property's reporting timezone
  is changed, days before the change stay bucketed on the old boundaries. Check
  `ga_properties.time_zone` before comparing across a change.
- **Internal traffic is counted** unless the property filters it. Site editors
  and staff show up as visitors.

## Tests

```bash
node --test test/google-analytics.test.js
```

Covers the read-only scope, the per-connector token file, date normalisation,
that values map by response header rather than request order, that every report
row maps onto real columns, and upsert-not-duplicate over the revision window.
The token-store tests stash and restore live credentials.
