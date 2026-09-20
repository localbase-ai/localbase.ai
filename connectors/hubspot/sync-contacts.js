#!/usr/bin/env node

/**
 * HubSpot Contacts Sync
 * Syncs all contacts to local SQLite database
 */

import { HubSpotService } from './index.js';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { mkdirSync } from 'fs';

dotenv.config({ path: 'env.local' });

const DB_PATH = './data/hubspot_contacts/hubspot-contacts.sqlite';

// Create data directory if it doesn't exist
mkdirSync('./data/hubspot_contacts', { recursive: true });

// Initialize database
const db = new Database(DB_PATH);

// Create contacts table with standard HubSpot properties
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    email TEXT,
    firstname TEXT,
    lastname TEXT,
    phone TEXT,
    mobilephone TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    zip TEXT,

    -- Company Info
    company TEXT,
    jobtitle TEXT,

    -- Analytics & Source
    hs_analytics_source TEXT,
    hs_analytics_source_data_1 TEXT,
    hs_analytics_source_data_2 TEXT,

    -- Lifecycle
    hs_lead_status TEXT,
    lifecyclestage TEXT,

    -- Timestamps
    createdate TEXT,
    lastmodifieddate TEXT,

    -- Metadata
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
  CREATE INDEX IF NOT EXISTS idx_contacts_lastmodified ON contacts(lastmodifieddate);
`);

console.log('🔄 Starting HubSpot contacts sync...\n');

const accessToken = process.env.HUBSPOT_ACCESS_TOKEN;
if (!accessToken) {
  console.error('❌ HUBSPOT_ACCESS_TOKEN not found in environment');
  process.exit(1);
}

const hubspot = new HubSpotService({ accessToken });

// Standard properties to fetch
const properties = [
  'email',
  'firstname',
  'lastname',
  'phone',
  'mobilephone',
  'city',
  'state',
  'country',
  'zip',
  'company',
  'jobtitle',
  'hs_analytics_source',
  'hs_analytics_source_data_1',
  'hs_analytics_source_data_2',
  'hs_lead_status',
  'lifecyclestage',
  'createdate',
  'lastmodifieddate'
];

let after = null;
let totalContacts = 0;
let page = 1;

const upsertStmt = db.prepare(`
  INSERT INTO contacts (
    id, email, firstname, lastname, phone, mobilephone, city, state, country, zip,
    company, jobtitle,
    hs_analytics_source, hs_analytics_source_data_1, hs_analytics_source_data_2,
    hs_lead_status, lifecyclestage,
    createdate, lastmodifieddate,
    updated_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?,
    ?, ?, ?,
    ?, ?,
    ?, ?,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT(id) DO UPDATE SET
    email = excluded.email,
    firstname = excluded.firstname,
    lastname = excluded.lastname,
    phone = excluded.phone,
    mobilephone = excluded.mobilephone,
    city = excluded.city,
    state = excluded.state,
    country = excluded.country,
    zip = excluded.zip,
    company = excluded.company,
    jobtitle = excluded.jobtitle,
    hs_analytics_source = excluded.hs_analytics_source,
    hs_analytics_source_data_1 = excluded.hs_analytics_source_data_1,
    hs_analytics_source_data_2 = excluded.hs_analytics_source_data_2,
    hs_lead_status = excluded.hs_lead_status,
    lifecyclestage = excluded.lifecyclestage,
    createdate = excluded.createdate,
    lastmodifieddate = excluded.lastmodifieddate,
    updated_at = CURRENT_TIMESTAMP
`);

try {
  do {
    console.log(`📄 Fetching page ${page}...`);

    const response = await hubspot.contacts.getContacts({
      limit: 100,
      after,
      properties
    });

    const contacts = response.results || [];

    // Insert/update contacts in database
    const upsertMany = db.transaction((contacts) => {
      for (const contact of contacts) {
        const props = contact.properties || {};
        upsertStmt.run(
          contact.id,
          props.email || null,
          props.firstname || null,
          props.lastname || null,
          props.phone || null,
          props.mobilephone || null,
          props.city || null,
          props.state || null,
          props.country || null,
          props.zip || null,
          props.company || null,
          props.jobtitle || null,
          props.hs_analytics_source || null,
          props.hs_analytics_source_data_1 || null,
          props.hs_analytics_source_data_2 || null,
          props.hs_lead_status || null,
          props.lifecyclestage || null,
          props.createdate || null,
          props.lastmodifieddate || null
        );
      }
    });

    upsertMany(contacts);

    totalContacts += contacts.length;
    console.log(`   ✓ Processed ${contacts.length} contacts (Total: ${totalContacts})`);

    after = response.paging?.next?.after;
    page++;

  } while (after);

  console.log(`\n✅ Contacts sync complete!`);
  console.log(`   Total contacts: ${totalContacts}`);

  // Show summary
  const stats = db.prepare('SELECT COUNT(*) as total FROM contacts').get();
  console.log(`   Database total: ${stats.total}`);

} catch (error) {
  console.error('❌ Sync failed:', error.message);
  process.exit(1);
} finally {
  db.close();
}
