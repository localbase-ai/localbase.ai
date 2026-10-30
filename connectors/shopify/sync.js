#!/usr/bin/env node
/**
 * Sync Shopify into data/shopify/shopify.db.
 *
 *   node connectors/shopify/sync.js                      incremental (orders + products)
 *   node connectors/shopify/sync.js --full               everything the token can see
 *   node connectors/shopify/sync.js --entities orders
 *   node connectors/shopify/sync.js --verbose            shows cost-bucket waits
 *
 * Watermarks live in sync_state, one row per (shop, entity), on `updated_at`.
 */
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { ShopifyClient } from './client.js';
import {
  DDL, ORDERS_QUERY, PRODUCTS_QUERY, ORDER_WINDOW_DAYS,
  orderRows, productRows, updatedSinceQuery,
} from './entities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTANCE_ROOT = join(__dirname, '..', '..');
const DB_PATH = join(INSTANCE_ROOT, 'data', 'shopify', 'shopify.db');

dotenv.config({ path: join(INSTANCE_ROOT, 'env.local'), quiet: true });

export function openDb(path = DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  for (const stmt of DDL) db.exec(stmt);
  return db;
}

const upserts = new Map();
/** INSERT … ON CONFLICT(pk) DO UPDATE, built once per table from a sample row. */
export function upsert(db, table, row) {
  const key = `${table}:${Object.keys(row).join(',')}`;
  let stmt = upserts.get(key);
  if (!stmt || stmt.database !== db) {
    const cols = Object.keys(row);
    const pk = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.pk).map((c) => c.name);
    const updatable = cols.filter((c) => !pk.includes(c));
    stmt = db.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
       ON CONFLICT(${pk.join(', ')}) DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(', ')}`
    );
    upserts.set(key, stmt);
  }
  stmt.run(row);
}

/**
 * Write one order and its children. Lines and refunds are replaced, not
 * merged: an order edit can remove a line, and an upsert alone would keep it.
 */
export function saveOrder(db, rows) {
  upsert(db, 'shopify_orders', rows.order);
  if (rows.attribution) upsert(db, 'shopify_order_attribution', rows.attribution);
  db.prepare('DELETE FROM shopify_order_lines WHERE order_id = ?').run(rows.order.id);
  for (const l of rows.lines) upsert(db, 'shopify_order_lines', l);
  db.prepare('DELETE FROM shopify_refunds WHERE order_id = ?').run(rows.order.id);
  for (const r of rows.refunds) upsert(db, 'shopify_refunds', r);
}

export function saveProduct(db, rows) {
  upsert(db, 'shopify_products', rows.product);
  db.prepare('DELETE FROM shopify_variants WHERE product_id = ?').run(rows.product.id);
  for (const v of rows.variants) upsert(db, 'shopify_variants', v);
}

export function getWatermark(db, shop, entity) {
  return db.prepare('SELECT watermark FROM sync_state WHERE shop = ? AND entity = ?')
    .get(shop, entity)?.watermark ?? null;
}

export function setWatermark(db, shop, entity, watermark, count) {
  db.prepare(`INSERT INTO sync_state (shop, entity, watermark, last_run_at, last_row_count)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(shop, entity) DO UPDATE SET
                watermark = COALESCE(excluded.watermark, sync_state.watermark),
                last_run_at = excluded.last_run_at,
                last_row_count = excluded.last_row_count`)
    .run(shop, entity, watermark, new Date().toISOString(), count);
}

const ENTITIES = {
  orders: {
    query: ORDERS_QUERY,
    path: 'orders',
    save: (db, node, ctx) => {
      const rows = orderRows(node, ctx);
      saveOrder(db, rows);
      return rows.order.lines_truncated;
    },
  },
  products: {
    query: PRODUCTS_QUERY,
    path: 'products',
    save: (db, node, ctx) => {
      const rows = productRows(node, ctx);
      saveProduct(db, rows);
      return rows.product.variants_truncated;
    },
  },
};

export async function syncEntity(client, db, name, { full = false, timeZone = null } = {}) {
  const entity = ENTITIES[name];
  const since = full ? null : getWatermark(db, client.shop, name);
  const query = updatedSinceQuery(since);
  process.stdout.write(`  ${name.padEnd(9)} ${query ? `updated since ${since}` : 'full'}\n`);

  const fetchedAt = new Date().toISOString();
  let count = 0;
  let truncated = 0;
  let maxUpdated = since;

  for await (const nodes of client.paginate(entity.query, { query }, entity.path)) {
    db.transaction(() => {
      for (const node of nodes) {
        truncated += entity.save(db, node, { fetchedAt, timeZone });
        if (node.updatedAt && (!maxUpdated || node.updatedAt > maxUpdated)) maxUpdated = node.updatedAt;
      }
    })();
    count += nodes.length;
    if (client.verbose) console.log(`   ${name}: ${count}`);
  }

  setWatermark(db, client.shop, name, maxUpdated, count);
  process.stdout.write(`  ${''.padEnd(9)} → ${count} ${name}`
    + (truncated ? ` (${truncated} with more children than one page — flagged *_truncated)` : '') + '\n');
  return count;
}

function parseArgs(argv) {
  const args = { full: false, verbose: false, entities: Object.keys(ENTITIES) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--entities') args.entities = argv[++i].split(',').map((s) => s.trim());
  }
  const unknown = args.entities.filter((e) => !ENTITIES[e]);
  if (unknown.length) throw new Error(`Unknown entity: ${unknown.join(', ')} (have ${Object.keys(ENTITIES).join(', ')})`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new ShopifyClient({ verbose: args.verbose });
  const db = openDb();
  const started = Date.now();

  const shop = await client.shopInfo();
  console.log(`🛍  Shopify · ${shop.name} (${client.shop}) · API ${client.version}`
    + ` · ${args.entities.join(', ')}${args.full ? ' · full pull' : ''}`);

  db.prepare(`INSERT INTO shopify_shop (shop, name, currency, time_zone, plan, created_at, scopes, last_synced_at)
              VALUES (@shop, @name, @currency, @tz, @plan, @created, @scopes, @now)
              ON CONFLICT(shop) DO UPDATE SET name = excluded.name, currency = excluded.currency,
                time_zone = excluded.time_zone, plan = excluded.plan, created_at = excluded.created_at,
                scopes = excluded.scopes, last_synced_at = excluded.last_synced_at`)
    .run({
      shop: client.shop, name: shop.name, currency: shop.currencyCode, tz: shop.ianaTimezone,
      plan: shop.plan?.displayName ?? null, created: shop.createdAt, scopes: shop.scopes.join(','),
      now: new Date().toISOString(),
    });

  if (args.entities.includes('orders') && !shop.scopes.includes('read_all_orders')) {
    console.log(`   ⚠️  token lacks read_all_orders — Shopify only returns the last ${ORDER_WINDOW_DAYS} days of orders.`);
    console.log('      Add the scope to the app and reinstall it to backfill older history (README).');
  }

  let total = 0;
  for (const name of args.entities) {
    total += await syncEntity(client, db, name, { full: args.full, timeZone: shop.ianaTimezone });
  }

  console.log(`\n✅ ${total} records in ${((Date.now() - started) / 1000).toFixed(1)}s → ${DB_PATH}`);
  db.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  });
}
