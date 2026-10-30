/**
 * Shopify — MCP tools over the locally synced database.
 *
 * Reads `data/shopify/shopify.db`, not the API, so queries are instant and cost
 * no rate-limit budget. Refresh with `node connectors/shopify/sync.js`.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SqliteConnector } from '../SqliteConnector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ShopifyConnector extends SqliteConnector {
  constructor() {
    super({
      name: 'shopify',
      prefix: 'shopify',
      label: 'Shopify',
      dbPath: join(__dirname, '..', '..', 'data', 'shopify', 'shopify.db'),
      syncHint: 'node connectors/shopify/sync.js',
      notes: 'Exclude test orders (test = 0). created_date is the store-local day; created_at is UTC. '
        + 'shopify_sales_daily books refunds on the order date, not the refund date (use shopify_refunds for that). '
        + 'No customer names, emails or addresses are stored — customer_id and ship city/province/country only. '
        + 'Attribution (first/last visit, UTMs) is in shopify_order_attribution.',
    });
  }
}

export default ShopifyConnector;
