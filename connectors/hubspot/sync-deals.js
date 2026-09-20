#!/usr/bin/env node

/**
 * HubSpot Deals Sync
 * Updates deals database with latest data from HubSpot API
 *
 * Usage:
 *   node sync-deals.js              # Full sync from 2022
 *   node sync-deals.js --since DATE # Incremental sync from DATE
 */

import { HubSpotService } from './index.js';
import dotenv from 'dotenv';

dotenv.config({ path: 'env.local' });

async function main() {
  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN;

  if (!accessToken) {
    console.error('❌ HUBSPOT_ACCESS_TOKEN not found in environment');
    process.exit(1);
  }

  // Parse command line arguments for incremental sync
  const args = process.argv.slice(2);
  const sinceIndex = args.indexOf('--since');
  let sinceDate = null;

  if (sinceIndex !== -1 && args[sinceIndex + 1]) {
    sinceDate = args[sinceIndex + 1];
    console.log(`🔄 Incremental sync: fetching deals modified since ${sinceDate}`);
  } else {
    console.log('🔄 Full sync: fetching all deals from 2022');
  }

  try {
    const hubspot = new HubSpotService({ accessToken });

    if (sinceDate) {
      // Incremental sync - fetch deals modified since last sync
      await hubspot.deals.updateDatabase({ sinceDate });
    } else {
      // Full sync - fetch all deals from 2022
      await hubspot.deals.updateDatabase({ startYear: 2022 });
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ HubSpot deals sync failed:', error.message);
    process.exit(1);
  }
}

main();
