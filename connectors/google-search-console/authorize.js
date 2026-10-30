#!/usr/bin/env node
/**
 * One-time Google authorization for Search Console.
 *
 *   node connectors/google-search-console/authorize.js
 *   node connectors/google-search-console/authorize.js --manual
 *
 * Prints every property the account can see; put the ones that belong to this
 * business in GSC_SITES.
 */
import * as auth from './auth.js';
import { main } from '../google-authorize.js';
import { SearchConsoleClient } from './client.js';

main({
  auth,
  label: 'read-only Search Console',
  afterConnect: async () => {
    const sites = await new SearchConsoleClient({}).listSites();
    console.log(`\n   ${sites.length} Search Console propert${sites.length === 1 ? 'y' : 'ies'} visible:\n`);
    for (const s of sites) console.log(`   ${s.siteUrl.padEnd(44)} ${s.permissionLevel}`);
    console.log('\n   Next: set GSC_SITES=<siteUrl,...> in env.local, then');
    console.log('         node connectors/google-search-console/sync.js --full');
  },
});
