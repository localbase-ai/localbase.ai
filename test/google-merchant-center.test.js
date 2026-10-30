/**
 * Google Merchant Center connector tests. All offline.
 *
 * No live account has been synced through this connector yet, so these pin the
 * mapping to the documented Merchant API shapes and, more importantly, the
 * snapshot rules: a product missing from a complete pull is marked gone, never
 * deleted, and child issues are replaced rather than piling up run over run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';

import { SCOPES, TOKEN_PATH, buildAuthorizeUrl } from '../connectors/google-merchant-center/auth.js';
import {
  productToRows, performanceToRow, accountIssueToRow, performanceQuery, performanceWindow,
  normaliseDate, micros, FINALISATION_DAYS, FULL_LOOKBACK_DAYS,
} from '../connectors/google-merchant-center/reports.js';
import {
  initDb, writeProductSnapshot, writeRows, writeAccountIssues,
} from '../connectors/google-merchant-center/store.js';
import { BASE, VERSIONS, PRODUCTS_PAGE_SIZE, explain } from '../connectors/google-merchant-center/client.js';
import { GoogleMerchantCenterConnector } from '../connectors/google-merchant-center/index.js';

const product = (offerId, overrides = {}) => ({
  name: `accounts/1/products/en~US~${offerId}`,
  offerId,
  contentLanguage: 'en',
  feedLabel: 'US',
  dataSource: 'accounts/1/dataSources/9',
  productAttributes: {
    title: `Mug ${offerId}`,
    brand: 'Acme',
    link: `https://example.com/${offerId}`,
    imageLink: 'https://example.com/i.jpg',
    price: { amountMicros: '1250000000', currencyCode: 'USD' },
    salePrice: { amountMicros: '999990000', currencyCode: 'USD' },
    availability: 'IN_STOCK',
    condition: 'NEW',
    productTypes: ['Kitchen', 'Mugs'],
    googleProductCategory: '200',
    customLabel0: 'blue',
    gtins: ['0001'],
  },
  productStatus: {
    destinationStatuses: [
      { reportingContext: 'SHOPPING_ADS', approvedCountries: ['US'] },
      { reportingContext: 'FREE_LISTINGS', disapprovedCountries: ['US'] },
    ],
    itemLevelIssues: [
      { code: 'missing_gtin', severity: 'DEMOTED', resolution: 'MERCHANT_ACTION', attribute: 'gtin',
        reportingContext: 'FREE_LISTINGS', description: 'Missing GTIN', applicableCountries: ['US'] },
    ],
    creationDate: '2026-01-01T00:00:00Z',
  },
  ...overrides,
});

describe('Merchant Center auth', () => {
  it('asks for the content scope only', () => {
    assert.deepStrictEqual(SCOPES, ['https://www.googleapis.com/auth/content']);
  });

  it('keeps its own token file', () => {
    assert.match(TOKEN_PATH, /data\/google-merchant-center\/tokens\.json$/);
  });

  it('requests offline access and forces consent', () => {
    const url = new URL(buildAuthorizeUrl({
      clientId: 'c', redirectUri: 'http://localhost:3458', state: 's', codeChallenge: 'x',
    }));
    assert.strictEqual(url.searchParams.get('access_type'), 'offline');
    assert.strictEqual(url.searchParams.get('prompt'), 'consent');
    assert.strictEqual(url.searchParams.get('scope'), SCOPES[0]);
  });
});

describe('Merchant Center client', () => {
  it('targets the Merchant API, not the Content API', () => {
    assert.strictEqual(BASE, 'https://merchantapi.googleapis.com');
    assert.ok(PRODUCTS_PAGE_SIZE <= 1000);
    for (const v of Object.values(VERSIONS)) assert.match(v, /^v1/);
  });

  it('points a registration failure at register.js', () => {
    const msg = explain(403, 'GCP project is not registered with the merchant account');
    assert.match(msg, /register\.js/);
  });

  it('points a disabled API at gcloud services enable', () => {
    assert.match(explain(403, 'Merchant API has not been used in project 1 before or it is disabled'),
      /services enable merchantapi/);
  });
});

describe('Merchant Center mapping', () => {
  it('maps a v1 product, its destinations and its issues', () => {
    const { product: p, destinations, issues } = productToRows(product('A1'), { accountId: '1', seenAt: 't' });
    assert.strictEqual(p.offer_id, 'A1');
    assert.strictEqual(p.title, 'Mug A1');
    assert.strictEqual(p.price, 1250);
    assert.strictEqual(p.sale_price, 999.99);
    assert.strictEqual(p.currency, 'USD');
    assert.strictEqual(p.channel, 'ONLINE');
    assert.strictEqual(p.has_image, 1);
    assert.strictEqual(p.product_types, 'Kitchen,Mugs');
    assert.strictEqual(p.custom_label_0, 'blue');
    assert.strictEqual(p.issue_count, 1);
    assert.strictEqual(p.disapproved_destinations, 1);
    assert.strictEqual(destinations.length, 2);
    assert.strictEqual(issues[0].code, 'missing_gtin');
    assert.strictEqual(issues[0].severity, 'DEMOTED');
    assert.strictEqual(issues[0].applicable_countries, 'US');
  });

  it('reads v1beta field names too, so a version override does not blank the table', () => {
    const beta = product('B1');
    beta.attributes = beta.productAttributes;
    delete beta.productAttributes;
    beta.channel = 'LOCAL';
    const { product: p } = productToRows(beta, { accountId: '1', seenAt: 't' });
    assert.strictEqual(p.title, 'Mug B1');
    assert.strictEqual(p.channel, 'LOCAL');
  });

  it('marks legacyLocal products as LOCAL', () => {
    const { product: p } = productToRows(product('L1', { legacyLocal: true }), { accountId: '1', seenAt: 't' });
    assert.strictEqual(p.channel, 'LOCAL');
  });

  it('maps a performance row with int64 strings, money and a structured date', () => {
    const row = performanceToRow({
      productPerformanceView: {
        date: { year: 2026, month: 3, day: 7 }, offerId: 'A1', title: 'Mug', marketingMethod: 'ORGANIC',
        clicks: '12', impressions: '340', clickThroughRate: 0.035, conversions: 1.5,
        conversionValue: { amountMicros: '2500000', currencyCode: 'USD' },
      },
    }, { accountId: '1', fetchedAt: 't' });
    assert.strictEqual(row.date, '2026-03-07');
    assert.strictEqual(row.clicks, 12);
    assert.strictEqual(row.impressions, 340);
    assert.strictEqual(row.conversion_value, 2.5);
    assert.strictEqual(row.marketing_method, 'ORGANIC');
  });

  it('normalises dates and money', () => {
    assert.strictEqual(normaliseDate({ year: 2026, month: 1, day: 2 }), '2026-01-02');
    assert.strictEqual(normaliseDate('2026-01-02'), '2026-01-02');
    assert.strictEqual(micros(null), null);
    assert.strictEqual(micros({ amountMicros: '1000000' }), 1);
  });

  it('every mapped row fits its table', () => {
    const db = initDb(new Database(':memory:'));
    const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    const { product: p, destinations, issues } = productToRows(product('A1'), { accountId: '1', seenAt: 't' });
    const checks = [
      ['mc_products', p], ['mc_product_destinations', destinations[0]], ['mc_product_issues', issues[0]],
      ['mc_performance_daily', performanceToRow({ productPerformanceView: { date: { year: 2026, month: 1, day: 1 } } },
        { accountId: '1', fetchedAt: 't' })],
      ['mc_account_issues', accountIssueToRow({ name: 'x', title: 'X' }, { accountId: '1', fetchedAt: 't' })],
    ];
    for (const [table, row] of checks) {
      const have = cols(table);
      for (const k of Object.keys(row)) assert.ok(have.has(k), `${table} has no column "${k}"`);
    }
    db.close();
  });

  it('builds a dated MQL query over product_performance_view', () => {
    const q = performanceQuery('2026-01-01', '2026-01-31');
    assert.match(q, /FROM product_performance_view/);
    assert.match(q, /date BETWEEN '2026-01-01' AND '2026-01-31'/);
    assert.match(q, /marketing_method/);
  });
});

describe('Merchant Center snapshot rules', () => {
  const run = (db, offers, seenAt) => writeProductSnapshot(
    db, '1', offers.map((o) => productToRows(product(o), { accountId: '1', seenAt })), seenAt);

  it('stamps products missing from a complete pull as disappeared, never deletes them', () => {
    const db = initDb(new Database(':memory:'));
    run(db, ['A', 'B'], '2026-01-01T00:00:00Z');
    const gone = run(db, ['A'], '2026-01-02T00:00:00Z');
    assert.strictEqual(gone, 1);
    const rows = db.prepare('SELECT offer_id, disappeared_at FROM mc_products ORDER BY offer_id').all();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].disappeared_at, null);
    assert.strictEqual(rows[1].disappeared_at, '2026-01-02T00:00:00Z');
    db.close();
  });

  it('clears disappeared_at when a product comes back, and keeps first_seen_at', () => {
    const db = initDb(new Database(':memory:'));
    run(db, ['A'], '2026-01-01T00:00:00Z');
    run(db, [], '2026-01-02T00:00:00Z');
    run(db, ['A'], '2026-01-03T00:00:00Z');
    const r = db.prepare('SELECT first_seen_at, last_seen_at, disappeared_at FROM mc_products').get();
    assert.strictEqual(r.disappeared_at, null);
    assert.strictEqual(r.first_seen_at, '2026-01-01T00:00:00Z');
    assert.strictEqual(r.last_seen_at, '2026-01-03T00:00:00Z');
    db.close();
  });

  it('replaces issues and destinations rather than accumulating them', () => {
    const db = initDb(new Database(':memory:'));
    run(db, ['A'], '2026-01-01T00:00:00Z');
    run(db, ['A'], '2026-01-02T00:00:00Z');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM mc_product_issues').get().n, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM mc_product_destinations').get().n, 2);
    db.close();
  });

  it('only touches the account being written', () => {
    const db = initDb(new Database(':memory:'));
    writeProductSnapshot(db, '2', [productToRows(product('Z'), { accountId: '2', seenAt: '2026-01-01T00:00:00Z' })],
      '2026-01-01T00:00:00Z');
    run(db, [], '2026-01-02T00:00:00Z');
    assert.strictEqual(db.prepare("SELECT disappeared_at FROM mc_products WHERE account_id = '2'").get().disappeared_at, null);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM mc_product_issues WHERE account_id = '2'").get().n, 1);
    db.close();
  });

  it('account issues are a snapshot too', () => {
    const db = initDb(new Database(':memory:'));
    writeAccountIssues(db, '1', [accountIssueToRow({ name: 'a', title: 'A' }, { accountId: '1', fetchedAt: 't' })]);
    writeAccountIssues(db, '1', []);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM mc_account_issues').get().n, 0);
    db.close();
  });

  it('re-pulling a performance day updates rather than duplicates', () => {
    const db = initDb(new Database(':memory:'));
    const mk = (clicks) => performanceToRow({ productPerformanceView: {
      date: { year: 2026, month: 1, day: 1 }, offerId: 'A', marketingMethod: 'ADS', clicks: String(clicks),
    } }, { accountId: '1', fetchedAt: 't' });
    writeRows(db, 'mc_performance_daily', [mk(3)]);
    writeRows(db, 'mc_performance_daily', [mk(9)]);
    const rows = db.prepare('SELECT clicks FROM mc_performance_daily').all();
    assert.deepStrictEqual(rows.map((r) => r.clicks), [9]);
    db.close();
  });
});

describe('Merchant Center incremental window', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('re-pulls the revision window before the watermark', () => {
    const w = performanceWindow('2026-06-10', false, now);
    assert.strictEqual(w.endDate, '2026-06-15');
    assert.strictEqual(w.startDate, '2026-06-07');
    assert.ok(FINALISATION_DAYS >= 2);
  });

  it('goes back the full lookback on a first or --full run', () => {
    const floor = new Date(now);
    floor.setUTCDate(floor.getUTCDate() - FULL_LOOKBACK_DAYS);
    const expected = floor.toISOString().slice(0, 10);
    assert.strictEqual(performanceWindow(null, false, now).startDate, expected);
    assert.strictEqual(performanceWindow('2026-06-10', true, now).startDate, expected);
  });

  it('never reaches past the lookback floor', () => {
    const w = performanceWindow('2020-01-01', false, now);
    assert.ok(w.startDate >= performanceWindow(null, false, now).startDate);
  });
});

describe('Merchant Center MCP connector', () => {
  it('exposes the standard read-only tools under the gmc prefix', async () => {
    const tools = await new GoogleMerchantCenterConnector().getTools();
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['gmc_query', 'gmc_schema', 'gmc_sync_status']);
  });
});
