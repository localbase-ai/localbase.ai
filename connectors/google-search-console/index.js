/**
 * Google Search Console — MCP tools over the locally synced database.
 *
 * Reads `data/google-search-console/gsc.db`, not the API, so queries are instant and cost no
 * quota. Refresh with `node connectors/google-search-console/sync.js`.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SqliteConnector } from '../SqliteConnector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class GoogleSearchConsoleConnector extends SqliteConnector {
  constructor() {
    super({
      name: 'google-search-console',
      prefix: 'gsc',
      label: 'Google Search Console',
      dbPath: join(__dirname, '..', '..', 'data', 'google-search-console', 'gsc.db'),
      syncHint: 'node connectors/google-search-console/sync.js',
      notes: 'Positions are per-row averages — weight them by impressions before comparing.',
    });
  }
}

export default GoogleSearchConsoleConnector;
