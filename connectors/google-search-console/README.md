# Google Search Console connector

Syncs Search Console performance data into `data/google-search-console/gsc.db`.

**The reason this is a connector and not an MCP server: Search Console deletes
performance data after 16 months, permanently.** There is no archive and no
recovery — BigQuery bulk export is the only other way to keep it. Every month
this does not run is a month that eventually falls off the back and is gone. An
MCP server answers questions about the last 16 months; this accumulates a
history you can still trend against in three years.

Google publishes no official Search Console MCP. The community ones wrap the
same public API and would need the same OAuth grant, so there is no shortcut
being passed up here.

## Setup

### 1. A Google OAuth client (shared by every Google connector)

Search Console uses the same OAuth client as GA4, Google Ads and Merchant
Center: `data/google/oauth-client.json` (or `GOOGLE_OAUTH_CLIENT_FILE`). See the
google-analytics README for creating one. Enable the API on the client's project:

```bash
gcloud services enable searchconsole.googleapis.com --project=<project>
```

### 2. Authorize

```bash
node connectors/google-search-console/authorize.js
node connectors/google-search-console/authorize.js --manual   # paste the URL back
```

Requests `webmasters.readonly`. The token lands in
`data/google-search-console/tokens.json` (gitignored, mode 0600), separate from
the other Google connectors' tokens. On success it prints every property the
account can see.

> The consent asks for this connector's scope only (no `include_granted_scopes`),
> so the token can read Search Console and nothing the same OAuth client was
> granted for another connector. A token authorized before that change may carry
> extra scopes; re-run `authorize.js` to replace it.

### 3. Choose properties

The login usually sees other businesses' properties. Syncing only runs against
an explicit allowlist in `env.local`, using the site URLs exactly as
`authorize.js` prints them:

```bash
GSC_SITES=sc-domain:example.com            # comma-separated for more than one
```

### 4. Sync

```bash
node connectors/google-search-console/sync.js --full       # first run: 16 months
node connectors/google-search-console/sync.js              # thereafter
node connectors/google-search-console/sync.js --site "sc-domain:example.com"   # one allowed site
node connectors/google-search-console/sync.js --reports daily,query
node connectors/google-search-console/sync.js --all-types  # image, video, news, discover
node connectors/google-search-console/sync.js --verbose
```

## What gets synced

One table per dimension shape, every one keyed on date:

| Table | Dimensions | Use |
|---|---|---|
| `gsc_daily` | date | headline clicks/impressions/CTR/position — **complete, use for totals** |
| `gsc_query_daily` | date, query | which searches bring traffic |
| `gsc_page_daily` | date, page | which URLs earn it |
| `gsc_geo_device_daily` | date, country, device | how much traffic is actually local |
| `gsc_appearance_daily` | date, searchAppearance | rich-result types |
| `gsc_sites` | — | properties visible to the account, with permission level |
| `sync_state` | — | watermark per (site, report, search type) |

### Why separate shallow reports rather than one wide query

Search Console does not return a full cube. The API "does not guarantee to
return all data rows but rather top ones", and each additional dimension makes
it truncate harder while more rows fall below Google's anonymisation threshold.
Asking for date × query × page × country × device in one call returns a heavily
sampled slice that reconciles with nothing.

**So the dimensional tables will not sum to `gsc_daily`, and that is a property
of the source, not a bug.** Take totals from `gsc_daily`; use the others for
composition only.

## Two caveats worth knowing

**Recent days keep changing.** Search Console finalises data over roughly 48–72
hours. Incremental runs therefore re-request a 4-day trailing window
(`FINALISATION_DAYS`) and upsert over it, rather than trusting the high-water
mark — a strict watermark would freeze those days at their first, incomplete
values and never correct them. Today is never requested at all.

**Queries are anonymised.** Google withholds rare queries entirely to protect
user privacy, so `gsc_query_daily` clicks will always total less than
`gsc_daily`. The gap is real data you cannot have; do not chase it.

## Quotas

Search Console enforces per-minute and per-day caps per site and per project and
answers a breach with HTTP 429. There is no budget header to pace against, so
the client keeps concurrency at one and backs off exponentially on 429 and 5xx,
up to five attempts.

A single response is capped at **25,000 rows**; paging continues until a page
comes back short, which is the only end-of-data signal the API offers.

## Tests

```bash
node --test test/google-search-console.test.js
```

Offline. Covers the read-only scope, that every report's table can be created,
that rows map positionally from the API's unnamed `keys`, that the standalone
appearance report is keyed by its window, and the connector's MCP tools.
