#!/usr/bin/env node

/**
 * HubSpot Companies Sync
 * Updates companies database with latest data from HubSpot API
 *
 * Usage:
 *   node sync-companies.js              # Full sync (all companies)
 *   node sync-companies.js --since DATE # Incremental sync from DATE
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
    console.log(`🔄 Incremental sync: fetching companies modified since ${sinceDate}`);
  } else {
    console.log('🔄 Full sync: fetching all companies');
  }

  try {
    const hubspot = new HubSpotService({ accessToken });

    if (sinceDate) {
      // Incremental sync - fetch companies modified since last sync
      await hubspot.companies.updateDatabase({ sinceDate });
    } else {
      // Full sync - fetch all companies
      await hubspot.companies.updateDatabase();
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ HubSpot companies sync failed:', error.message);
    process.exit(1);
  }
}

main();
