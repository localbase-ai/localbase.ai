/**
 * Shopify connector tests. All offline — fetch is mocked.
 *
 * No live store has been synced through this yet, so these guard the parts
 * that are ours to get right: auth paths, cost-based pacing, mapping without
 * personal data, and re-sync semantics.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  normaliseShopDomain, tokenProvider, isExpired, readTokens, SCOPES,
} from '../connectors/shopify/auth.js';
import { ShopifyClient, waitForCost, isThrottled, MAX_QUERY_COST } from '../connectors/shopify/client.js';
import {
  DDL, orderRows, productRows, localDate, updatedSinceQuery,
  ORDER_PAGE, ORDER_LINES_PAGE, PRODUCT_PAGE, VARIANTS_PAGE, ORDERS_QUERY,
} from '../connectors/shopify/entities.js';
import { saveOrder, saveProduct, getWatermark, setWatermark } from '../connectors/shopify/sync.js';
import { ShopifyConnector } from '../connectors/shopify/index.js';

const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

const memDb = () => {
  const db = new Database(':memory:');
  for (const s of DDL) db.exec(s);
  return db;
};

const order = (over = {}) => ({
  id: 'gid://shopify/Order/1',
  name: '#1001',
  createdAt: '2026-03-01T03:30:00Z',
  updatedAt: '2026-03-02T10:00:00Z',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  currencyCode: 'USD',
  sourceName: 'web',
  tags: ['vip', 'gift'],
  test: false,
  channelInformation: { channelDefinition: { handle: 'online_store', channelName: 'Online Store' } },
  customer: { id: 'gid://shopify/Customer/9' },
  shippingAddress: { city: 'Springfield', provinceCode: 'MO', countryCodeV2: 'US' },
  subtotalPriceSet: { shopMoney: { amount: '90.00' } },
  totalDiscountsSet: { shopMoney: { amount: '10.00' } },
  totalTaxSet: { shopMoney: { amount: '7.20' } },
  totalShippingPriceSet: { shopMoney: { amount: '5.00' } },
  totalPriceSet: { shopMoney: { amount: '102.20' } },
  totalRefundedSet: { shopMoney: { amount: '20.00' } },
  currentTotalPriceSet: { shopMoney: { amount: '82.20' } },
  customerJourneySummary: {
    ready: true,
    daysToConversion: 3,
    momentsCount: { count: 4 },
    firstVisit: {
      source: 'google', sourceType: 'SEO', landingPage: 'https://shop.example/mugs',
      referrerUrl: 'https://www.google.com/', occurredAt: '2026-02-26T12:00:00Z',
      utmParameters: null,
    },
    lastVisit: {
      source: 'facebook', sourceType: 'PAID', landingPage: 'https://shop.example/?utm_source=fb',
      referrerUrl: null, occurredAt: '2026-03-01T03:00:00Z',
      utmParameters: { source: 'fb', medium: 'paid_social', campaign: 'spring', content: 'ad1', term: null },
    },
  },
  refunds: [{ id: 'gid://shopify/Refund/5', createdAt: '2026-03-05T15:00:00Z', note: 'size', totalRefundedSet: { shopMoney: { amount: '20.00' } } }],
  lineItems: {
    pageInfo: { hasNextPage: false },
    nodes: [
      { id: 'gid://shopify/LineItem/11', sku: 'R-1', title: 'Mug', variantTitle: 'Large', quantity: 1,
        product: { id: 'gid://shopify/Product/2' }, variant: { id: 'gid://shopify/ProductVariant/3' },
        originalTotalSet: { shopMoney: { amount: '60.00' } }, discountedTotalSet: { shopMoney: { amount: '55.00' } } },
      { id: 'gid://shopify/LineItem/12', sku: '', title: 'Widget', variantTitle: null, quantity: 2,
        product: null, variant: null,
        originalTotalSet: { shopMoney: { amount: '40.00' } }, discountedTotalSet: { shopMoney: { amount: '35.00' } } },
    ],
  },
  ...over,
});

describe('Shopify auth', () => {
  it('normalises the store domain', () => {
    assert.strictEqual(normaliseShopDomain('my-store'), 'my-store.myshopify.com');
    assert.strictEqual(normaliseShopDomain('My-Store.myshopify.com'), 'my-store.myshopify.com');
    assert.strictEqual(normaliseShopDomain('https://my-store.myshopify.com/admin'), 'my-store.myshopify.com');
    assert.throws(() => normaliseShopDomain('shop.example.com'), /myshopify\.com/);
    assert.throws(() => normaliseShopDomain(''), /SHOPIFY_STORE_DOMAIN/);
  });

  it('rejects a domain that only ends in myshopify.com', () => {
    // The client secret is posted to this host.
    for (const v of ['evil.com#.myshopify.com', 'evil.com?.myshopify.com', ['a', 'evil.myshopify.com'].join('@'), 'x.y.myshopify.com']) {
      assert.throws(() => normaliseShopDomain(v), /myshopify\.com/, v);
    }
  });

  it('asks only for read scopes', () => {
    for (const s of SCOPES) assert.match(s, /^read_/);
  });

  it('a static access token wins over client credentials', async () => {
    const p = tokenProvider({ SHOPIFY_STORE_DOMAIN: 's', SHOPIFY_ACCESS_TOKEN: ' shpat_x ', SHOPIFY_CLIENT_ID: 'c', SHOPIFY_CLIENT_SECRET: 'k' },
      { fetchImpl: () => { throw new Error('should not fetch'); } });
    assert.strictEqual(p.mode, 'access-token');
    assert.strictEqual(await p.get(), 'shpat_x');
  });

  it('refuses to run with no credentials', () => {
    assert.throws(() => tokenProvider({ SHOPIFY_STORE_DOMAIN: 's' }), /No Shopify credentials/);
  });

  it('treats a token without expiry as permanent and a missing one as expired', () => {
    assert.strictEqual(isExpired(null), true);
    assert.strictEqual(isExpired({ accessToken: 'a' }), false);
    assert.strictEqual(isExpired({ accessToken: 'a', expiresAt: new Date(Date.now() + 60_000).toISOString() }), true);
    assert.strictEqual(isExpired({ accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), false);
  });

  describe('client credentials grant', () => {
    let dir;
    let tokenPath;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shopify-')); tokenPath = join(dir, 'tokens.json'); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const env = { SHOPIFY_STORE_DOMAIN: 'my-store', SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: 'sec' };

    it('exchanges, caches owner-only, and reuses the token', async () => {
      const calls = [];
      const fetchImpl = async (url, init) => {
        calls.push({ url, body: String(init.body) });
        return json({ access_token: 'tok1', scope: 'read_orders', expires_in: 86399 });
      };
      const p = tokenProvider(env, { fetchImpl, tokenPath });
      assert.strictEqual(await p.get(), 'tok1');
      assert.strictEqual(await p.get(), 'tok1');
      assert.strictEqual(calls.length, 1, 'second call should use the cache');
      assert.strictEqual(calls[0].url, 'https://my-store.myshopify.com/admin/oauth/access_token');
      assert.match(calls[0].body, /grant_type=client_credentials/);
      assert.match(calls[0].body, /client_id=cid/);
      assert.strictEqual(statSync(tokenPath).mode & 0o777, 0o600);
      assert.strictEqual(readTokens(tokenPath).shop, 'my-store.myshopify.com');

      // a new process reads the cache rather than asking again
      const p2 = tokenProvider(env, { fetchImpl, tokenPath });
      assert.strictEqual(await p2.get(), 'tok1');
      assert.strictEqual(calls.length, 1);
    });

    it('refreshes when forced, and surfaces a failed exchange', async () => {
      let n = 0;
      const p = tokenProvider(env, { fetchImpl: async () => json({ access_token: `tok${++n}`, expires_in: 86399 }), tokenPath });
      await p.get();
      assert.strictEqual(await p.get({ force: true }), 'tok2');

      const bad = tokenProvider(env, {
        fetchImpl: async () => json({ error: 'invalid_client' }, 400),
        tokenPath: join(dir, 'other.json'),
      });
      await assert.rejects(bad.get(), /invalid_client/);
    });
  });
});

describe('Shopify client pacing', () => {
  it('waits only as long as the bucket needs to refill', () => {
    assert.strictEqual(waitForCost(null, 500), 0);
    assert.strictEqual(waitForCost({ currentlyAvailable: 800, restoreRate: 50 }, 500), 0);
    assert.strictEqual(waitForCost({ currentlyAvailable: 100, restoreRate: 50 }, 600), 10000);
  });

  it('recognises THROTTLED errors', () => {
    assert.ok(isThrottled([{ message: 'Throttled', extensions: { code: 'THROTTLED' } }]));
    assert.ok(!isThrottled([{ message: 'nope' }]));
    assert.ok(!isThrottled(undefined));
  });

  const staticTokens = { shop: 's.myshopify.com', mode: 'access-token', get: async () => 't' };

  it('retries THROTTLED and paces from throttleStatus', async () => {
    const sleeps = [];
    const responses = [
      json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: { cost: { requestedQueryCost: 300, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 } } } }),
      json({ data: { ok: true }, extensions: { cost: { requestedQueryCost: 300, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 700, restoreRate: 50 } } } }),
    ];
    const seen = [];
    const client = new ShopifyClient({
      env: { SHOPIFY_API_VERSION: '2026-01' },
      tokens: staticTokens,
      fetchImpl: async (url, init) => { seen.push({ url, init }); return responses.shift(); },
      sleepImpl: async (ms) => { sleeps.push(ms); },
    });
    assert.deepStrictEqual(await client.graphql('{ ok }'), { ok: true });
    assert.strictEqual(seen[0].url, 'https://s.myshopify.com/admin/api/2026-01/graphql.json');
    assert.strictEqual(seen[0].init.headers['X-Shopify-Access-Token'], 't');
    assert.ok(sleeps.includes(4000), `expected a 4s refill wait, got ${sleeps}`);
  });

  it('raises GraphQL errors with a scope hint', async () => {
    const client = new ShopifyClient({
      env: {}, tokens: staticTokens, sleepImpl: async () => {},
      fetchImpl: async () => json({ errors: [{ message: 'Access denied for orders field. Required access: `read_orders` access scope.' }] }),
    });
    await assert.rejects(client.graphql('{ orders }'), /denied access.*scopes/);
  });

  it('paginates by cursor until hasNextPage is false', async () => {
    const pages = [
      { orders: { nodes: [{ id: 1 }, { id: 2 }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } },
      { orders: { nodes: [{ id: 3 }], pageInfo: { hasNextPage: false, endCursor: 'c2' } } },
    ];
    const afters = [];
    const client = new ShopifyClient({
      env: {}, tokens: staticTokens, sleepImpl: async () => {},
      fetchImpl: async (_u, init) => { afters.push(JSON.parse(init.body).variables.after); return json({ data: pages.shift() }); },
    });
    const ids = [];
    for await (const nodes of client.paginate('q', { query: null }, 'orders')) ids.push(...nodes.map((n) => n.id));
    assert.deepStrictEqual(ids, [1, 2, 3]);
    assert.deepStrictEqual(afters, [null, 'c1']);
  });

  it('page sizes keep nested queries under the single-query cost cap', () => {
    assert.ok(ORDER_PAGE * (1 + ORDER_LINES_PAGE) < MAX_QUERY_COST);
    assert.ok(PRODUCT_PAGE * (1 + VARIANTS_PAGE) < MAX_QUERY_COST);
  });
});

describe('Shopify mapping', () => {
  it('never requests or emits customer contact details', () => {
    assert.doesNotMatch(ORDERS_QUERY, /\b(email|phone|firstName|lastName|displayName|address1|address2|zip)\b/);
    const rows = orderRows(order(), { fetchedAt: 't', timeZone: 'America/Chicago' });
    for (const k of Object.keys(rows.order)) assert.doesNotMatch(k, /email|phone|name_first|last_name|address|zip/);
    assert.strictEqual(rows.order.customer_id, 'gid://shopify/Customer/9');
    assert.strictEqual(rows.order.ship_city, 'Springfield');
  });

  it('maps money, net, channel and tags', () => {
    const { order: o } = orderRows(order(), { fetchedAt: 't', timeZone: 'UTC' });
    assert.strictEqual(o.subtotal, 90);
    assert.strictEqual(o.total_refunded, 20);
    assert.strictEqual(o.net, 70);
    assert.strictEqual(o.channel, 'Online Store');
    assert.strictEqual(o.tags, 'vip, gift');
    assert.strictEqual(o.test, 0);
    assert.strictEqual(o.line_count, 2);
    assert.strictEqual(o.lines_truncated, 0);
  });

  it('dates orders on the store-local day', () => {
    // 03:30 UTC on Mar 1 is the evening of Feb 28 in Chicago.
    assert.strictEqual(orderRows(order(), { fetchedAt: 't', timeZone: 'America/Chicago' }).order.created_date, '2026-02-28');
    assert.strictEqual(localDate('2026-03-01T03:30:00Z', null), '2026-03-01');
    assert.strictEqual(localDate(null, 'UTC'), null);
  });

  it('maps first and last visit attribution', () => {
    const { attribution: a } = orderRows(order(), { fetchedAt: 't' });
    assert.strictEqual(a.first_source, 'google');
    assert.strictEqual(a.first_utm_source, null);
    assert.strictEqual(a.last_utm_source, 'fb');
    assert.strictEqual(a.last_utm_campaign, 'spring');
    assert.strictEqual(a.moments_count, 4);
    assert.strictEqual(a.days_to_conversion, 3);
    assert.strictEqual(orderRows(order({ customerJourneySummary: null }), { fetchedAt: 't' }).attribution, null);
  });

  it('flags orders whose line items run past one page', () => {
    const o = order({ lineItems: { pageInfo: { hasNextPage: true }, nodes: [] } });
    assert.strictEqual(orderRows(o, { fetchedAt: 't' }).order.lines_truncated, 1);
  });

  it('maps products and variants', () => {
    const { product, variants } = productRows({
      id: 'gid://shopify/Product/2', title: 'Mug', handle: 'mug', productType: '', vendor: 'V', status: 'ACTIVE',
      tags: [], totalInventory: 4, createdAt: 'a', updatedAt: 'b', publishedAt: null,
      priceRangeV2: { minVariantPrice: { amount: '50.0', currencyCode: 'USD' }, maxVariantPrice: { amount: '80.0' } },
      variants: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'v1', title: '7', sku: 'R-7', price: '50.00', compareAtPrice: null, inventoryQuantity: 4 }] },
    }, { fetchedAt: 't' });
    assert.strictEqual(product.product_type, null);
    assert.strictEqual(product.min_price, 50);
    assert.strictEqual(product.variant_count, 1);
    assert.strictEqual(variants[0].price, 50);
    assert.strictEqual(variants[0].compare_at_price, null);
  });

  it('builds the incremental filter with a revision margin', () => {
    assert.strictEqual(updatedSinceQuery(null), null);
    assert.strictEqual(updatedSinceQuery('2026-03-10T00:00:00Z'), "updated_at:>='2026-03-08T00:00:00.000Z'");
  });
});

describe('Shopify storage', () => {
  it('every mapped row fits its table', () => {
    const db = memDb();
    const rows = orderRows(order(), { fetchedAt: 't', timeZone: 'UTC' });
    saveOrder(db, rows); // throws on an unknown column
    const p = productRows({ id: 'p', variants: { nodes: [{ id: 'v' }] } }, { fetchedAt: 't' });
    saveProduct(db, p);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shopify_order_lines').get().n, 2);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shopify_variants').get().n, 1);
    db.close();
  });

  it('re-syncing an order updates it and replaces its lines', () => {
    const db = memDb();
    saveOrder(db, orderRows(order(), { fetchedAt: 't1', timeZone: 'UTC' }));
    const edited = order({
      totalRefundedSet: { shopMoney: { amount: '45.00' } },
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [order().lineItems.nodes[0]] },
    });
    saveOrder(db, orderRows(edited, { fetchedAt: 't2', timeZone: 'UTC' }));
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shopify_orders').get().n, 1);
    assert.strictEqual(db.prepare('SELECT total_refunded FROM shopify_orders').get().total_refunded, 45);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shopify_order_lines').get().n, 1);
    db.close();
  });

  it('daily sales view excludes test orders', () => {
    const db = memDb();
    saveOrder(db, orderRows(order(), { fetchedAt: 't', timeZone: 'UTC' }));
    saveOrder(db, orderRows(order({ id: 'gid://shopify/Order/2', test: true, refunds: [], lineItems: { nodes: [] } }), { fetchedAt: 't', timeZone: 'UTC' }));
    const day = db.prepare('SELECT * FROM shopify_sales_daily').all();
    assert.strictEqual(day.length, 1);
    assert.strictEqual(day[0].orders, 1);
    assert.strictEqual(day[0].gross_sales, 100);
    assert.strictEqual(day[0].net_sales, 70);
    const src = db.prepare('SELECT * FROM shopify_sales_by_source_daily').get();
    assert.strictEqual(src.first_source, 'google');
    db.close();
  });

  it('watermarks are per shop and entity, and a null run keeps the old one', () => {
    const db = memDb();
    setWatermark(db, 's', 'orders', '2026-03-02T10:00:00Z', 5);
    setWatermark(db, 's', 'orders', null, 0);
    assert.strictEqual(getWatermark(db, 's', 'orders'), '2026-03-02T10:00:00Z');
    assert.strictEqual(getWatermark(db, 's', 'products'), null);
    db.close();
  });
});

describe('Shopify MCP connector', () => {
  it('exposes the standard read-only tools', async () => {
    const tools = (await new ShopifyConnector().getTools()).map((t) => t.name);
    assert.deepStrictEqual(tools, ['shopify_query', 'shopify_schema', 'shopify_sync_status']);
  });
});
