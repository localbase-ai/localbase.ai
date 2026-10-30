#!/usr/bin/env node
/**
 * One-time Google authorization for Merchant Center.
 *
 *   node connectors/google-merchant-center/authorize.js
 *   node connectors/google-merchant-center/authorize.js --manual
 *
 * Prints every Merchant Center account the login can reach; put the ones that
 * belong to this business in MERCHANT_ACCOUNT_IDS.
 */
import * as auth from './auth.js';
import { main } from '../google-authorize.js';
import { MerchantClient } from './client.js';

main({
  auth,
  label: 'Google Merchant Center',
  afterConnect: async () => {
    let accounts = [];
    try {
      accounts = await new MerchantClient({}).listAccounts();
    } catch (err) {
      console.log(`\n   Could not list accounts yet: ${err.message}`);
      console.log('   If the account ID is known, set MERCHANT_ACCOUNT_IDS and run register.js.');
      return;
    }
    console.log(`\n   ${accounts.length} Merchant Center account(s) visible:\n`);
    for (const a of accounts) {
      console.log(`   ${String(a.accountId).padEnd(14)} ${a.accountName ?? ''}${a.testAccount ? '  (test)' : ''}`);
    }
    console.log('\n   Next: set MERCHANT_ACCOUNT_IDS=<id,...> in env.local, then');
    console.log('         node connectors/google-merchant-center/sync.js --full');
  },
});
