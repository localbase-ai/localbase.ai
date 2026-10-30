/**
 * CallRail — MCP tools over the locally synced database.
 *
 * Reads `data/callrail/callrail.db`, not the API, so queries are instant and
 * cost no rate-limit budget. Refresh with `node connectors/callrail/sync.js`.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SqliteConnector } from '../SqliteConnector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class CallRailConnector extends SqliteConnector {
  constructor() {
    super({
      name: 'callrail',
      prefix: 'callrail',
      label: 'CallRail',
      dbPath: join(__dirname, '..', '..', 'data', 'callrail', 'callrail.db'),
      syncHint: 'node connectors/callrail/sync.js',
      notes: 'One row per call in callrail_calls; callrail_calls_daily rolls them up by date, source and campaign. '
        + 'Callers are identified only by caller_hash (a salted hash of the number) — names and numbers are not stored. '
        + 'lead_status = \'good_lead\' marks a qualified lead. Tags are in callrail_call_tags. '
        + 'Filter by company_id when more than one company is synced.',
    });
  }
}

export default CallRailConnector;
