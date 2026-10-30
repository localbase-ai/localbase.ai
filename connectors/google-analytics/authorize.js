#!/usr/bin/env node
/**
 * One-time Google authorization for GA4.
 *
 *   node connectors/google-analytics/authorize.js
 *   node connectors/google-analytics/authorize.js --manual
 *
 * Prints every property the account can see; put the ones that belong to this
 * business in GA4_PROPERTIES.
 */
import * as auth from './auth.js';
import { main } from '../google-authorize.js';
import { AnalyticsClient } from './client.js';

main({
  auth,
  label: 'read-only Google Analytics',
  afterConnect: async () => {
    const props = await new AnalyticsClient({}).listPropertySummaries();
    console.log(`\n   ${props.length} GA4 propert${props.length === 1 ? 'y' : 'ies'} visible:\n`);
    for (const p of props) {
      console.log(`   ${String(p.propertyId).padEnd(12)} ${(p.displayName ?? '').padEnd(34)} ${p.accountName ?? ''}`);
    }
    console.log('\n   Next: set GA4_PROPERTIES=<id,...> in env.local, then');
    console.log('         node connectors/google-analytics/sync.js --full');
  },
});
