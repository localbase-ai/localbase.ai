# Google Merchant Center connector

Syncs a Merchant Center account into `data/google-merchant-center/merchant.db`:
the product catalogue and its approval status, item- and account-level issues,
and daily clicks and impressions per product from free listings and Shopping
ads.

Built on the **Merchant API** (`merchantapi.googleapis.com`), not the Content
API for Shopping, which Google is sunsetting in 2026.

## Setup

### 1. OAuth client

Uses the workspace's shared Google OAuth client. If you have not set one up,
follow [section 1 of the Google Analytics README](../google-analytics/README.md#1-a-google-oauth-client-shared-by-every-google-connector).
On the same Cloud project, enable the Merchant API:

```bash
gcloud services enable merchantapi.googleapis.com
```

The Google account you sign in with must be a user on the Merchant Center
account (Merchant Center → Settings → People and access).

### 2. Authorize

```bash
node connectors/google-merchant-center/authorize.js          # opens the browser
node connectors/google-merchant-center/authorize.js --manual # paste the redirect URL instead
```

Requests the `content` scope and prints every Merchant Center account the
login can reach. The Merchant API has no read-only scope; this connector only
reads, apart from the registration step below.

### 3. Register the Cloud project with the account

Google requires the Cloud project behind the OAuth client to be registered with
each Merchant Center account before the API will serve it. An unregistered
project gets a permission error, not a message saying "register first". It is
a one-time write, dry by default:

```bash
node connectors/google-merchant-center/register.js --account 123456789 --email <your email>
node connectors/google-merchant-center/register.js --account 123456789 --email <your email> --commit
```

The email is the developer contact Google notifies about API changes; it should
be a user on the account.

### 4. Choose accounts

A login can often reach more than one business's account (agency access,
advanced accounts with sub-accounts). Syncing only runs against an explicit
allowlist in `env.local`:

```bash
MERCHANT_ACCOUNT_IDS=123456789          # comma-separated for more than one
```

Optional overrides, if Google moves a sub-API version before this connector
does:

```bash
MERCHANT_ACCOUNTS_API_VERSION=v1
MERCHANT_PRODUCTS_API_VERSION=v1
MERCHANT_REPORTS_API_VERSION=v1
```

### 5. Sync

```bash
node connectors/google-merchant-center/sync.js --full                    # performance back FULL_LOOKBACK_DAYS (365)
node connectors/google-merchant-center/sync.js                           # incremental
node connectors/google-merchant-center/sync.js --account 123456789
node connectors/google-merchant-center/sync.js --reports products,issues
node connectors/google-merchant-center/sync.js --verbose
```

## What gets synced

| Table | Grain | Contents |
|---|---|---|
| `mc_accounts` | account | name, timezone, language, test flag |
| `mc_products` | product (snapshot) | offer id, title, brand, channel, feed label, language, price, sale price, availability, condition, product type, Google category, custom labels 0–4, GTIN/MPN, link, image present, issue count, `raw_json` |
| `mc_product_destinations` | product × reporting context | approved / pending / disapproved countries |
| `mc_product_issues` | issue | code, severity, resolution, attribute, reporting context, description |
| `mc_account_issues` | issue (snapshot) | title, severity, impacted destinations |
| `mc_performance_daily` | date × offer × marketing method | clicks, impressions, CTR, conversions, conversion value |
| `sync_state` | account × report | watermark and last run |

## Snapshots vs daily data

**Products are a snapshot.** The API only says what is in the feed *now*, so
every run re-fetches the whole catalogue. A product that is no longer returned
is stamped `disappeared_at` rather than deleted — the local table is the only
record it existed. A product that comes back has the stamp cleared.
`first_seen_at` is when this connector first saw it, not when it was created in
Merchant Center (that is `creation_date`). Issues and destination statuses are
replaced wholesale on each run, so they always describe the current state.

**Performance is daily.** Incremental runs re-pull the last
`FINALISATION_DAYS` (3) before the watermark and upsert over them, because
recent days are revised.

## Caveats

- **Free listings and Shopping ads are separate rows.** `marketing_method` is
  `ORGANIC` for free listings and `ADS` for Shopping ads. Sum both for an
  offer's total; filter to `ADS` to compare with Google Ads.
- **Shopify-fed catalogues.** If products arrive through the Google & YouTube
  app for Shopify, the feed is Shopify's and fixes belong there; edits made in
  Merchant Center get overwritten on the next Shopify sync. Offer IDs from that
  app usually look like `shopify_US_<product id>_<variant id>`, which is the
  join key back to Shopify.
- **Conversions here are Google's** (Merchant Center / Google Ads conversion
  tracking), not orders from the store. Expect them to disagree with Shopify.
- **Low-volume rows may be missing.** Google omits or thresholds some
  low-volume report rows; do not treat a missing day as zero clicks without
  checking.
- **Not synced:** price competitiveness and best sellers. Both views need
  Market Insights eligibility and are of limited use for a small catalogue.

## Tests

```bash
node --test test/google-merchant-center.test.js
```

Offline. Covers the scope and token file, product and report mapping across
v1 and v1beta field names, money and date normalisation, the snapshot rules
(disappeared, reappeared, issues replaced not accumulated), the incremental
window, and the registration hint on permission errors.
