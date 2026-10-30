/**
 * Meta (Facebook + Instagram) — MCP tools over the locally synced database.
 *
 * Reads `data/meta/meta.db`, not the Graph API, so queries are instant and cost
 * no rate-limit budget. Refresh with `node connectors/meta/sync.js`.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SqliteConnector } from '../SqliteConnector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class MetaConnector extends SqliteConnector {
  constructor() {
    super({
      name: 'meta',
      prefix: 'meta',
      label: 'Meta (Facebook + Instagram)',
      dbPath: join(__dirname, '..', '..', 'data', 'meta', 'meta.db'),
      syncHint: 'node connectors/meta/sync.js',
      notes: 'Ads: meta_campaign_daily / meta_adset_daily / meta_ad_daily are the SAME spend at three levels — never sum across them. '
        + 'Every action type is in meta_actions_daily (level, object_id, date, action_type); headline ones (leads, calls_placed, messaging_starts) are also columns. '
        + 'Page and Instagram insights are long tables (date, metric, value); meta_metric_errors lists metrics Meta rejected. '
        + 'Budgets are in the currency minor unit (*_minor).',
    });
  }
}

export default MetaConnector;
