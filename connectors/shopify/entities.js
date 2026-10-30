/**
 * What this connector pulls from Shopify, and how each node becomes rows.
 *
 * Privacy: orders are stored WITHOUT customer names, emails, phones or street
 * addresses. An order keeps its `customer_id` (to count repeat buyers) and the
 * shipping city / province / country (for geography). Nothing else about the
 * person is requested from the API, so it never reaches the database.
 *
 * Page sizes are set against Shopify's 1,000-point cap on a single query: a
 * nested connection costs roughly parent × child, so 20 orders × 30 line items
 * sits well under it. An order with more line items than that is flagged
 * (`lines_truncated = 1`) rather than silently short.
 */

export const ORDER_PAGE = 20;
export const ORDER_LINES_PAGE = 30;
export const PRODUCT_PAGE = 20;
export const VARIANTS_PAGE = 40;

/**
 * Orders keep changing after they are placed — refunds, fulfilment, edits —
 * and each change bumps `updated_at`. Incremental runs re-pull from the
 * watermark minus this margin, which also covers clock skew.
 */
export const REVISION_DAYS = 2;

/** Without read_all_orders, Shopify only returns orders from the last 60 days. */
export const ORDER_WINDOW_DAYS = 60;

const MONEY = 'shopMoney { amount }';
const VISIT = `source sourceType landingPage referrerUrl occurredAt
  utmParameters { source medium campaign content term }`;

export const ORDERS_QUERY = `query Orders($after: String, $query: String) {
  orders(first: ${ORDER_PAGE}, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt processedAt updatedAt cancelledAt cancelReason closedAt
      displayFinancialStatus displayFulfillmentStatus currencyCode
      sourceName tags test
      channelInformation { channelDefinition { handle channelName } }
      customer { id }
      shippingAddress { city provinceCode countryCodeV2 }
      subtotalPriceSet { ${MONEY} }
      totalDiscountsSet { ${MONEY} }
      totalTaxSet { ${MONEY} }
      totalShippingPriceSet { ${MONEY} }
      totalPriceSet { ${MONEY} }
      totalRefundedSet { ${MONEY} }
      currentTotalPriceSet { ${MONEY} }
      customerJourneySummary {
        ready daysToConversion
        momentsCount { count }
        firstVisit { ${VISIT} }
        lastVisit { ${VISIT} }
      }
      refunds { id createdAt note totalRefundedSet { ${MONEY} } }
      lineItems(first: ${ORDER_LINES_PAGE}) {
        pageInfo { hasNextPage }
        nodes {
          id sku title variantTitle quantity
          product { id }
          variant { id }
          originalTotalSet { ${MONEY} }
          discountedTotalSet { ${MONEY} }
        }
      }
    }
  }
}`;

export const PRODUCTS_QUERY = `query Products($after: String, $query: String) {
  products(first: ${PRODUCT_PAGE}, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle productType vendor status tags
      createdAt updatedAt publishedAt totalInventory
      priceRangeV2 {
        minVariantPrice { amount currencyCode }
        maxVariantPrice { amount }
      }
      variants(first: ${VARIANTS_PAGE}) {
        pageInfo { hasNextPage }
        nodes { id title sku barcode price compareAtPrice inventoryQuantity createdAt updatedAt }
      }
    }
  }
}`;

/* ------------------------------------------------------------------ DDL -- */

export const DDL = [
  `CREATE TABLE IF NOT EXISTS shopify_orders (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at TEXT, created_date TEXT, processed_at TEXT, updated_at TEXT,
    cancelled_at TEXT, cancel_reason TEXT, closed_at TEXT,
    financial_status TEXT, fulfillment_status TEXT, currency TEXT,
    subtotal REAL, total_discounts REAL, total_tax REAL, total_shipping REAL,
    total_price REAL, total_refunded REAL, current_total REAL, net REAL,
    source_name TEXT, channel TEXT, channel_handle TEXT,
    customer_id TEXT,
    ship_city TEXT, ship_province TEXT, ship_country TEXT,
    tags TEXT, test INTEGER,
    line_count INTEGER, lines_truncated INTEGER,
    fetched_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS shopify_order_attribution (
    order_id TEXT PRIMARY KEY,
    ready INTEGER, days_to_conversion INTEGER, moments_count INTEGER,
    first_source TEXT, first_source_type TEXT, first_landing_page TEXT, first_referrer TEXT, first_visit_at TEXT,
    first_utm_source TEXT, first_utm_medium TEXT, first_utm_campaign TEXT, first_utm_content TEXT, first_utm_term TEXT,
    last_source TEXT, last_source_type TEXT, last_landing_page TEXT, last_referrer TEXT, last_visit_at TEXT,
    last_utm_source TEXT, last_utm_medium TEXT, last_utm_campaign TEXT, last_utm_content TEXT, last_utm_term TEXT,
    fetched_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS shopify_order_lines (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    product_id TEXT, variant_id TEXT, sku TEXT, title TEXT, variant_title TEXT,
    quantity INTEGER, original_total REAL, discounted_total REAL,
    fetched_at TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_shopify_order_lines_order ON shopify_order_lines(order_id)',
  `CREATE TABLE IF NOT EXISTS shopify_refunds (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    created_at TEXT, created_date TEXT,
    amount REAL, note TEXT,
    fetched_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS shopify_products (
    id TEXT PRIMARY KEY,
    title TEXT, handle TEXT, product_type TEXT, vendor TEXT, status TEXT, tags TEXT,
    created_at TEXT, updated_at TEXT, published_at TEXT,
    total_inventory INTEGER, min_price REAL, max_price REAL, currency TEXT,
    variant_count INTEGER, variants_truncated INTEGER,
    fetched_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS shopify_variants (
    id TEXT PRIMARY KEY,
    product_id TEXT,
    title TEXT, sku TEXT, barcode TEXT,
    price REAL, compare_at_price REAL, inventory_quantity INTEGER,
    created_at TEXT, updated_at TEXT,
    fetched_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS shopify_shop (
    shop TEXT PRIMARY KEY,
    name TEXT, currency TEXT, time_zone TEXT, plan TEXT, created_at TEXT,
    scopes TEXT, last_synced_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    shop TEXT,
    entity TEXT,
    watermark TEXT,
    last_run_at TEXT,
    last_row_count INTEGER,
    PRIMARY KEY (shop, entity)
  )`,
  // Sales per store-local day, by order date. Test orders excluded; cancelled
  // orders kept, since their refunds net them out. Shopify's own Sales report
  // books a refund on the day it happens, so its daily net can differ from
  // this one even though the totals over a whole period agree.
  `CREATE VIEW IF NOT EXISTS shopify_sales_daily AS
    SELECT created_date AS date,
           COUNT(*) AS orders,
           ROUND(SUM(subtotal + total_discounts), 2) AS gross_sales,
           ROUND(SUM(total_discounts), 2) AS discounts,
           ROUND(SUM(total_refunded), 2) AS refunds,
           ROUND(SUM(subtotal - total_refunded), 2) AS net_sales,
           ROUND(SUM(total_price), 2) AS total_price,
           COUNT(DISTINCT customer_id) AS customers
      FROM shopify_orders
     WHERE test = 0
     GROUP BY created_date`,
  `CREATE VIEW IF NOT EXISTS shopify_sales_by_source_daily AS
    SELECT o.created_date AS date,
           COALESCE(a.first_utm_source, a.first_source, '(unknown)') AS first_source,
           COALESCE(a.first_utm_medium, a.first_source_type, '(unknown)') AS first_medium,
           COUNT(*) AS orders,
           ROUND(SUM(o.subtotal - o.total_refunded), 2) AS net_sales
      FROM shopify_orders o
      LEFT JOIN shopify_order_attribution a ON a.order_id = o.id
     WHERE o.test = 0
     GROUP BY 1, 2, 3`,
];

/* -------------------------------------------------------------- mappers -- */

export const money = (set) => {
  const v = set?.shopMoney?.amount;
  return v == null ? null : Number(v);
};

const num = (v) => (v == null || v === '' ? null : Number(v));

/** ISO timestamp → YYYY-MM-DD in the store's timezone (what Shopify reports use). */
export function localDate(iso, timeZone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (!timeZone) return d.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** One order node → rows for every order table. */
export function orderRows(node, { fetchedAt, timeZone }) {
  const lines = node.lineItems?.nodes ?? [];
  const subtotal = money(node.subtotalPriceSet);
  const refunded = money(node.totalRefundedSet) ?? 0;

  const order = {
    id: node.id,
    name: node.name ?? null,
    created_at: node.createdAt ?? null,
    created_date: localDate(node.createdAt, timeZone),
    processed_at: node.processedAt ?? null,
    updated_at: node.updatedAt ?? null,
    cancelled_at: node.cancelledAt ?? null,
    cancel_reason: node.cancelReason ?? null,
    closed_at: node.closedAt ?? null,
    financial_status: node.displayFinancialStatus ?? null,
    fulfillment_status: node.displayFulfillmentStatus ?? null,
    currency: node.currencyCode ?? null,
    subtotal,
    total_discounts: money(node.totalDiscountsSet),
    total_tax: money(node.totalTaxSet),
    total_shipping: money(node.totalShippingPriceSet),
    total_price: money(node.totalPriceSet),
    total_refunded: refunded,
    current_total: money(node.currentTotalPriceSet),
    net: subtotal == null ? null : Math.round((subtotal - refunded) * 100) / 100,
    source_name: node.sourceName ?? null,
    channel: node.channelInformation?.channelDefinition?.channelName ?? null,
    channel_handle: node.channelInformation?.channelDefinition?.handle ?? null,
    customer_id: node.customer?.id ?? null,
    ship_city: node.shippingAddress?.city ?? null,
    ship_province: node.shippingAddress?.provinceCode ?? null,
    ship_country: node.shippingAddress?.countryCodeV2 ?? null,
    tags: (node.tags ?? []).join(', ') || null,
    test: node.test ? 1 : 0,
    line_count: lines.length,
    lines_truncated: node.lineItems?.pageInfo?.hasNextPage ? 1 : 0,
    fetched_at: fetchedAt,
  };

  const j = node.customerJourneySummary;
  const visit = (v, p) => ({
    [`${p}_source`]: v?.source ?? null,
    [`${p}_source_type`]: v?.sourceType ?? null,
    [`${p}_landing_page`]: v?.landingPage ?? null,
    [`${p}_referrer`]: v?.referrerUrl ?? null,
    [`${p}_visit_at`]: v?.occurredAt ?? null,
    [`${p}_utm_source`]: v?.utmParameters?.source ?? null,
    [`${p}_utm_medium`]: v?.utmParameters?.medium ?? null,
    [`${p}_utm_campaign`]: v?.utmParameters?.campaign ?? null,
    [`${p}_utm_content`]: v?.utmParameters?.content ?? null,
    [`${p}_utm_term`]: v?.utmParameters?.term ?? null,
  });
  const attribution = j ? {
    order_id: node.id,
    ready: j.ready ? 1 : 0,
    days_to_conversion: num(j.daysToConversion),
    moments_count: num(j.momentsCount?.count),
    ...visit(j.firstVisit, 'first'),
    ...visit(j.lastVisit, 'last'),
    fetched_at: fetchedAt,
  } : null;

  const lineRows = lines.map((l) => ({
    id: l.id,
    order_id: node.id,
    product_id: l.product?.id ?? null,
    variant_id: l.variant?.id ?? null,
    sku: l.sku || null,
    title: l.title ?? null,
    variant_title: l.variantTitle ?? null,
    quantity: num(l.quantity),
    original_total: money(l.originalTotalSet),
    discounted_total: money(l.discountedTotalSet),
    fetched_at: fetchedAt,
  }));

  const refunds = (node.refunds ?? []).map((r) => ({
    id: r.id,
    order_id: node.id,
    created_at: r.createdAt ?? null,
    created_date: localDate(r.createdAt, timeZone),
    amount: money(r.totalRefundedSet),
    note: r.note ?? null,
    fetched_at: fetchedAt,
  }));

  return { order, attribution, lines: lineRows, refunds };
}

/** One product node → its product row and variant rows. */
export function productRows(node, { fetchedAt }) {
  const variants = node.variants?.nodes ?? [];
  return {
    product: {
      id: node.id,
      title: node.title ?? null,
      handle: node.handle ?? null,
      product_type: node.productType || null,
      vendor: node.vendor || null,
      status: node.status ?? null,
      tags: (node.tags ?? []).join(', ') || null,
      created_at: node.createdAt ?? null,
      updated_at: node.updatedAt ?? null,
      published_at: node.publishedAt ?? null,
      total_inventory: num(node.totalInventory),
      min_price: num(node.priceRangeV2?.minVariantPrice?.amount),
      max_price: num(node.priceRangeV2?.maxVariantPrice?.amount),
      currency: node.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
      variant_count: variants.length,
      variants_truncated: node.variants?.pageInfo?.hasNextPage ? 1 : 0,
      fetched_at: fetchedAt,
    },
    variants: variants.map((v) => ({
      id: v.id,
      product_id: node.id,
      title: v.title ?? null,
      sku: v.sku || null,
      barcode: v.barcode || null,
      price: num(v.price),
      compare_at_price: num(v.compareAtPrice),
      inventory_quantity: num(v.inventoryQuantity),
      created_at: v.createdAt ?? null,
      updated_at: v.updatedAt ?? null,
      fetched_at: fetchedAt,
    })),
  };
}

/** Shopify search syntax for "changed since", with the revision margin applied. */
export function updatedSinceQuery(watermark, marginDays = REVISION_DAYS) {
  if (!watermark) return null;
  const d = new Date(watermark);
  d.setUTCDate(d.getUTCDate() - marginDays);
  return `updated_at:>='${d.toISOString()}'`;
}
