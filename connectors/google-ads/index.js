/**
 * Google Ads — MCP tools over the locally synced database.
 *
 * Reads `data/google-ads/ads.db`, not the API, so queries are instant and cost
 * no quota. Refresh with `node connectors/google-ads/sync.js`.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SqliteConnector } from '../SqliteConnector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class GoogleAdsConnector extends SqliteConnector {
  constructor() {
    super({
      name: 'google-ads',
      prefix: 'gads',
      label: 'Google Ads',
      dbPath: join(__dirname, '..', '..', 'data', 'google-ads', 'ads.db'),
      syncHint: 'node connectors/google-ads/sync.js',
      notes: 'Filter by customer_id when ads_customers holds more than one account. Money is in the account currency: '
        + 'cost (REAL) and cost_micros (exact integer). Dates are in the account timezone. '
        + 'Calls: phone_calls in ads_campaign_daily counts calls from ads and call assets; '
        + 'ads_calls has one row per forwarded call; for call CONVERSIONS join ads_conversion_daily to '
        + 'ads_conversion_actions on conversion_action and read type (AD_CALL = from the ad, '
        + 'WEBSITE_CALL = from the site\'s forwarding number, CLICK_TO_CALL = a tap on the number, not a completed call). '
        + 'ads_search_term_daily omits low-volume terms, so it does not sum to keyword totals.',
    });
  }
}

export default GoogleAdsConnector;
