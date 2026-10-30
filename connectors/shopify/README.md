# Shopify connector

Syncs a Shopify store's orders, attribution, line items, refunds, products and
variants into `data/shopify/shopify.db`. Sales can then be joined locally with
ads, analytics and call data, which Shopify's own reports can't do.

Read-only. The connector never writes to the store.

## Setup

You connect with an app that you own on your own store. Data goes straight
between your machine and Shopify, and the app's keys live only in your
`env.local`.

There are two kinds of app. **Use the first unless you already have the second.**

### A. Dev Dashboard app (new setups)

Shopify stopped letting merchants create new custom apps in the store admin in
early 2026. New apps are made in the Dev Dashboard and authenticate with the
**client credentials grant**: the client ID and secret are exchanged for an
access token that lasts about a day. The connector does that exchange itself and
caches the token in `data/shopify/tokens.json`, which is owner-only and
gitignored.

1. In the store admin, open **Settings → Apps → Develop apps**, then follow the
   link to the **Dev Dashboard** (or go to
   [dev.shopify.com](https://dev.shopify.com/)). Sign in as the store owner or a
   staff member with app development permission.
2. **Create an app** and give it these **Admin API access scopes**:
   - `read_orders`
   - `read_all_orders`: without it, Shopify returns only the **last 60 days**
     of orders (see below)
   - `read_products`
   - `read_inventory`
3. Release a version with those scopes, then **install the app on your store**.
   The client credentials grant only works for an app installed on a store in
   the same organization.
4. Copy the app's **Client ID** and **Client secret** into `env.local`:

   ```bash
   SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
   SHOPIFY_CLIENT_ID=...
   SHOPIFY_CLIENT_SECRET=...
   ```

### B. Existing admin custom app

If the store already has a custom app made in the admin (Settings → Apps →
Develop apps), its Admin API access token (`shpat_…`) still works and never
expires. Give it the same scopes as above, then set:

```bash
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_...
```

If both are set, `SHOPIFY_ACCESS_TOKEN` wins.

`SHOPIFY_STORE_DOMAIN` must be the store's **myshopify.com** domain, not its
custom domain. It's listed in Settings → Domains. Just the handle
(`your-store`) works too.

### Read-only scopes and `read_all_orders`

`read_all_orders` is what lets a sync reach orders older than 60 days. Without
it, Shopify **silently** returns only the last 60 days: no error, just less
history. At the start of each run the sync reads the token's scopes and warns
when this one is missing. To add it later, add the scope, release, and approve
the updated scopes on the store, then run `--full`.

## Sync

```bash
node connectors/shopify/sync.js --full               # everything the token can see
node connectors/shopify/sync.js                      # incremental
node connectors/shopify/sync.js --entities orders    # orders,products
node connectors/shopify/sync.js --verbose            # shows rate-limit waits
```

Incremental runs ask for records with `updated_at` at or after the last
watermark, less a **2-day margin**. Orders keep changing after they're placed
(refunds, fulfilment, edits), and each change bumps `updated_at`, so a refunded
order from last month is picked up on the next run. Re-pulled orders are
upserted. Their line items and refunds are replaced, so an edit that removes a
line removes it locally too.

## What gets synced

| Table | What it holds |
|---|---|
| `shopify_orders` | One row per order: status, totals (subtotal, discounts, tax, shipping, total, refunded, net), sales channel, `customer_id`, shipping city / province / country, tags, test flag |
| `shopify_order_attribution` | Shopify's customer journey for the order: first and last visit source, source type, landing page, referrer, UTM source / medium / campaign / content / term, days to conversion, number of moments |
| `shopify_order_lines` | Line items: product, variant, SKU, title, quantity, original and discounted totals |
| `shopify_refunds` | Refunds, dated by when they happened |
| `shopify_products` | Products: type, vendor, status, tags, total inventory, price range |
| `shopify_variants` | Variants: SKU, barcode, price, compare-at price, inventory |
| `shopify_shop` | Store metadata: currency, timezone, plan, and the scopes the token holds |
| `shopify_sales_daily` (view) | Orders, gross sales, discounts, refunds, net sales and distinct customers per store-local day |
| `shopify_sales_by_source_daily` (view) | Orders and net sales per day by first-visit source / medium (UTM first, Shopify's source otherwise) |

## Privacy

**No customer names, emails, phone numbers or street addresses are stored.**
The query never asks for them, so they never reach the database. An order keeps
only:

- `customer_id`, enough to count repeat buyers without knowing who they are
- shipping **city, province and country**, for geography

Refunds keep Shopify's refund `note`, free text staff type, which can mention
a customer by name; treat `shopify_refunds.note` as personal data.

The database can be shared, queried by AI clients, or synced elsewhere without
carrying customer contact details. If a workflow genuinely needs them, read them
from Shopify at that point rather than widening this sync.

## Caveats

- **Daily figures are in the store's timezone.** `created_date` is the
  store-local day, the same one Shopify's reports use. `created_at` is UTC.
- **Refund timing.** `shopify_sales_daily` books an order's refunds against the
  day the *order* was placed. Shopify's Sales report books them on the day of
  the refund, so daily net sales can differ while period totals agree. For
  refund-date reporting use `shopify_refunds.created_date`.
- **Net sales** here is subtotal (after discounts, before tax and shipping)
  minus refunds. Refunds that include shipping or tax make it slightly
  conservative.
- **Large orders and products are flagged, not dropped.** One query may cost at
  most 1,000 points, so each order brings up to 30 line items and each product
  up to 40 variants. Anything with more is marked `lines_truncated = 1` /
  `variants_truncated = 1`, and the sync reports how many.
- **Attribution needs Shopify's tracking.** `shopify_order_attribution` comes
  from Shopify's online-store session tracking. Orders from POS, drafts, or
  other channels usually have no journey, and `ready = 0` means Shopify hadn't
  finished computing it. Visitors who declined tracking cookies can show no
  source.
- **Deleted records aren't removed.** A product deleted in Shopify stays in the
  local table with its last known values.
- **API version** is pinned in `client.js` (`DEFAULT_API_VERSION`). Shopify
  supports each quarterly version for about a year. Override with
  `SHOPIFY_API_VERSION` and re-run a sync after a bump.

## Rate limits

Shopify meters GraphQL by **query cost**, not request count: each store has a
bucket of points (1,000 on standard plans) that refills every second. Each
response reports the bucket's state. The client waits for it to refill before a
query that wouldn't fit, and retries on `THROTTLED`, 429 and 5xx.

## Tests

```bash
node --test test/shopify.test.js
```

Offline. Covers shop-domain normalisation, both auth paths (including caching
and refreshing the client-credentials token), cost-based pacing and THROTTLED
retries, cursor pagination, the order and product mappers (no personal fields
emitted, store-local dates, truncation flags), upsert and child replacement on
re-sync, and the daily sales view.
