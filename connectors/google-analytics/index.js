/**
 * Google Analytics 4 — MCP tools over the locally synced database.
 *
 * Reads `data/google-analytics/ga.db`, not the API, so queries are instant and cost no
 * quota. Refresh with `node connectors/google-analytics/sync.js`; it also runs daily on launchd
 * (see CLAUDE.md, *Scheduled syncs*).
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SqliteConnector } from '../SqliteConnector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class GoogleAnalyticsConnector extends SqliteConnector {
  constructor() {
    super({
      name: 'google-analytics',
      prefix: 'ga4',
      label: 'Google Analytics 4',
      dbPath: join(__dirname, '..', '..', 'data', 'google-analytics', 'ga.db'),
      syncHint: 'node connectors/google-analytics/sync.js',
      notes: 'Filter by property when ga.db holds more than one (see ga_properties); an unfiltered SUM silently mixes them. Rows are per-day and per-dimension, and only ga_source_medium_daily and ga_campaign_daily carry a source column.',
    });
  }
}

export default GoogleAnalyticsConnector;
