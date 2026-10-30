# Google Ads connector

Syncs Google Ads performance into `data/google-ads/ads.db` — accounts,
campaigns, ad groups, keywords, search terms, conversions by action, cities,
and one row per call through a Google forwarding number. Locally it joins with
GA4, call tracking and orders, which no single ad platform does for you.

Read-only in practice: it only ever runs `googleAds:searchStream` and
`customers:listAccessibleCustomers`. (Google offers one scope, `adwords`, and it
is read/write — the grant itself cannot be narrowed.)

## Setup

### 1. The shared Google OAuth client

Follow [section 1 of the GA4 README](../google-analytics/README.md#1-a-google-oauth-client-shared-by-every-google-connector)
if the workspace does not have `data/google/oauth-client.json` yet. Then enable
the Google Ads API on the same Cloud project:

```bash
gcloud services enable googleads.googleapis.com
```

### 2. A developer token — usually the blocker

Every Google Ads API call carries a developer token as well as the OAuth token.
It comes from a **manager (MCC) account**: sign in to the manager account, then
*Tools → API Center*. Fill in the form and copy the token into `env.local`:

```bash
GOOGLE_ADS_DEVELOPER_TOKEN=...
```

**A new token is test-only.** It can read test accounts and nothing else; a real
account answers `DEVELOPER_TOKEN_NOT_APPROVED`. Apply for **Basic access** in API
Center (Google reviews the application, typically days, and asks what the tool
does). Until it is approved this connector cannot read a real account, however
the rest is set up. Plan for that wait.

A token is also bound to the first Cloud project that uses it
(`DEVELOPER_TOKEN_PROHIBITED` from any other project).

### 3. Access to the ad account

Either of these works:

- **Through a manager account.** Link the business's ad account under the
  manager that owns the developer token, sign in below as a user of that
  manager, and set
  `GOOGLE_ADS_LOGIN_CUSTOMER_ID=<manager id>` in `env.local`.
- **Direct.** Sign in as a user who has been granted access to the ad account
  itself, and leave `GOOGLE_ADS_LOGIN_CUSTOMER_ID` unset.

The wrong choice reads `USER_PERMISSION_DENIED`.

### 4. Authorize

```bash
node connectors/google-ads/authorize.js          # opens the browser
node connectors/google-ads/authorize.js --manual # paste the redirect URL instead
```

Stores its own token at `data/google-ads/tokens.json` and prints every account
the login can reach (directly, and under the manager if one is set).

### 5. Choose accounts

A login — especially a manager's — usually reaches more than one business's
accounts. Syncing only runs against an explicit allowlist:

```bash
GOOGLE_ADS_CUSTOMER_IDS=1234567890        # comma-separated; the dashed form from the Ads UI works too
```

### 6. Sync

```bash
node connectors/google-ads/sync.js --full                  # back 3 years (GOOGLE_ADS_FULL_DAYS)
node connectors/google-ads/sync.js                         # incremental
node connectors/google-ads/sync.js --customer 1234567890   # one account
node connectors/google-ads/sync.js --reports campaign,calls
node connectors/google-ads/sync.js --verbose
```

## What gets synced

| Table | Grain |
|---|---|
| `ads_customer_daily` | account × day — impressions, clicks, cost, conversions, interactions, phone calls |
| `ads_campaign_daily` | campaign × day — the above plus search impression share (lost to budget / rank) |
| `ads_ad_group_daily` | ad group × day |
| `ads_keyword_daily` | keyword × day — text, match type, status, current quality score |
| `ads_search_term_daily` | search term × ad group × day |
| `ads_conversion_daily` | campaign × conversion action × day — conversions, value, all conversions |
| `ads_geo_daily` | campaign × city × location type × day |
| `ads_calls` | one row per call — start/end, duration, status, caller area code and country |
| `ads_campaigns`, `ads_ad_groups`, `ads_conversion_actions` | settings, re-read whole each run |
| `ads_customers` | account name, currency, timezone |
| `ads_geo_targets` | location id → name, filled in for the cities that appear |

Money is stored twice: `cost_micros` (exact integer, millionths of the account
currency) and `cost` (REAL, currency units). Same for `budget`.

## Calls — three different numbers

For a business that wants the phone to ring, these are easy to conflate:

- **`phone_calls`** (campaign/account daily) — calls placed from an ad or a
  call asset through a Google forwarding number.
- **`ads_calls`** — the same calls, one row each, with duration and whether they
  were answered (`call_status`). Only exists when call reporting is on. Google
  never exposes the full caller number.
- **Call conversions** — `ads_conversion_daily` joined to `ads_conversion_actions`
  on `conversion_action`. `type` tells them apart: `AD_CALL` (from the ad, usually
  over a minimum duration), `WEBSITE_CALL` (the site's Google forwarding number),
  `CLICK_TO_CALL` (a tap on the number — **not** a completed call).

A separate call-tracking product (CallRail and similar) sees calls Google does
not, and vice versa; do not expect them to match.

## How Google Ads behaves

**Recent days are restated.** Clicks and cost settle within a few days;
conversions keep arriving for each action's conversion window (30 days by
default, up to 90). Incremental runs re-pull the trailing 30 days
(`REVISION_DAYS` in `reports.js`) and upsert over them.

**Dates and money are the account's.** `segments.date` is in the account's
timezone, and cost is in its currency (`ads_customers`).

**Search terms are partial.** Google hides low-volume terms, so
`ads_search_term_daily` will not sum to keyword or campaign totals.

**Quality score is a snapshot.** `quality_score` on every keyword row is the
current score at sync time, not the score on that date.

**Absent means zero, except impression share.** The API omits metrics at their
default, so a missing metric is stored as 0. Impression share is NULL when
Google did not compute it (non-search campaigns, too little volume).

**Fields are validated by the API, not by us.** GAQL rejects incompatible
field combinations outright. If a query here starts failing after a version
bump, the error names the field.

## API version

Pinned to `v22` in `client.js`. Google sunsets each version about a year after
release, after which every call fails (often a 404). Bump it with
`GOOGLE_ADS_API_VERSION=v<N>` in `env.local`, or in `client.js` for everyone,
after checking the Google Ads API release notes for field changes.

## Tests

```bash
node --test test/google-ads.test.js
```

Offline. Covers the scope and token file, that every report row maps onto its
table's columns, camelCase response paths, micros and NULL-vs-zero handling,
NULL-free primary keys (so re-pulls upsert), the GAQL each report generates,
revision windows and chunking, and the error parser's hints.

**Not yet validated against the live API** — no approved developer token was
available when this was written. The first real sync should be run with
`--verbose`, one report at a time, and any field GAQL rejects fixed here.
