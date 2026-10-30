/**
 * Google Merchant Center — MCP tools over the locally synced database.
 *
 * Reads `data/google-merchant-center/merchant.db`, not the API, so queries are
 * instant and cost no quota. Refresh with `node connectors/google-merchant-center/sync.js`.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SqliteConnector } from '../SqliteConnector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class GoogleMerchantCenterConnector extends SqliteConnector {
  constructor() {
    super({
      name: 'google-merchant-center',
      prefix: 'gmc',
      label: 'Google Merchant Center',
      dbPath: join(__dirname, '..', '..', 'data', 'google-merchant-center', 'merchant.db'),
      syncHint: 'node connectors/google-merchant-center/sync.js',
      notes: 'mc_products is the current catalogue snapshot: exclude rows with disappeared_at set unless you want history. '
        + 'mc_performance_daily splits each offer by marketing_method (ORGANIC = free listings, ADS = Shopping ads); '
        + 'sum both for total clicks. Filter by account_id when more than one account is synced. '
        + 'Item problems are in mc_product_issues (severity DISAPPROVED means the product is not shown).',
    });
  }
}

export default GoogleMerchantCenterConnector;
