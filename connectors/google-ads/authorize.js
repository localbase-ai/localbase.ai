#!/usr/bin/env node
/**
 * One-time Google authorization for Google Ads.
 *
 *   node connectors/google-ads/authorize.js
 *   node connectors/google-ads/authorize.js --manual
 *
 * Sign in as a user with access to the ad account (directly, or through the
 * manager account in GOOGLE_ADS_LOGIN_CUSTOMER_ID). Prints every account the
 * login can reach; put this business's in GOOGLE_ADS_CUSTOMER_IDS.
 */
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as auth from './auth.js';
import { main } from '../google-authorize.js';
import { AdsClient } from './client.js';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'env.local'), quiet: true });

main({
  auth,
  label: 'Google Ads',
  afterConnect: async () => {
    if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      console.log('\n   Set GOOGLE_ADS_DEVELOPER_TOKEN in env.local to list accounts (see README).');
      return;
    }
    const client = new AdsClient({});
    const ids = await client.listAccessibleCustomers();
    console.log(`\n   ${ids.length} account${ids.length === 1 ? '' : 's'} with direct access:\n`);
    for (const id of ids) {
      const c = await client.describeCustomer(id);
      const name = c?.descriptiveName ?? '(name not readable — may need GOOGLE_ADS_LOGIN_CUSTOMER_ID)';
      console.log(`   ${id.padEnd(12)} ${name}${c?.manager ? '  [manager]' : ''}`);
    }
    const managed = await client.listManagedCustomers().catch((err) => {
      console.log(`\n   Could not list accounts under the manager: ${err.message}`);
      return [];
    });
    if (managed.length) {
      console.log(`\n   Under manager ${client.loginCustomerId}:\n`);
      for (const c of managed) {
        console.log(`   ${String(c.id).padEnd(12)} ${c.descriptiveName ?? ''}${c.manager ? '  [manager]' : ''}  ${c.status ?? ''}`);
      }
    }
    console.log('\n   Next: set GOOGLE_ADS_CUSTOMER_IDS=<id,...> in env.local, then');
    console.log('         node connectors/google-ads/sync.js --full');
  },
});
