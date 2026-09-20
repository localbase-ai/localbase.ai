#!/usr/bin/env node

/**
 * HubSpot Event Sync
 * Polls HubSpot deals, contacts, and notes — diffs against local snapshot, posts changes to Slack
 *
 * Usage:
 *   node sync-deal-events.js           # Diff and post changes
 *   node sync-deal-events.js --dry-run # Show what would be posted without sending
 *   node sync-deal-events.js --init    # Initialize snapshot without posting (first run)
 */

import { HubSpotService } from './index.js';
import { SlackClient } from '../slack/client.js';
import {
  formatDealCreated,
  formatStageChanged,
  formatAmountChanged,
  formatDealClosed,
  formatContactCreated,
  formatContactUpdated,
  formatNoteAdded
} from '../slack/index.js';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({ path: 'env.local' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOT_DB = path.join(__dirname, '..', '..', 'data', 'hubspot_deals', 'deal-snapshots.sqlite');

function openDb() {
  const db = new Database(SNAPSHOT_DB);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS deal_snapshot (
      id TEXT PRIMARY KEY,
      name TEXT,
      amount REAL,
      stage TEXT,
      close_date TEXT,
      pipeline TEXT,
      is_closed_won INTEGER,
      is_closed_lost INTEGER,
      owner_id TEXT,
      owner_name TEXT,
      snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_snapshot (
      id TEXT PRIMARY KEY,
      firstname TEXT,
      lastname TEXT,
      email TEXT,
      company TEXT,
      jobtitle TEXT,
      lifecyclestage TEXT,
      hs_lead_status TEXT,
      snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_snapshot (
      id TEXT PRIMARY KEY,
      body_preview TEXT,
      contact_id TEXT,
      company_id TEXT,
      deal_id TEXT,
      created_at TEXT,
      snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

// --- Fetchers ---

async function fetchCurrentDeals(hubspot) {
  const properties = [
    'dealname', 'amount', 'dealstage', 'closedate', 'pipeline',
    'hs_is_closed_won', 'hs_is_closed_lost', 'hubspot_owner_id'
  ];

  let allDeals = [];
  let after = undefined;

  do {
    const response = await hubspot.client.makeRequest('/crm/v3/objects/deals/search', {
      method: 'POST',
      body: {
        filterGroups: [{
          filters: [{
            propertyName: 'createdate',
            operator: 'GTE',
            value: new Date('2022-01-01').getTime().toString()
          }]
        }],
        properties,
        limit: 200,
        after
      }
    });

    allDeals = allDeals.concat(response.results || []);
    after = response.paging?.next?.after;
  } while (after);

  const ownersMap = await hubspot.deals.fetchOwners();

  return allDeals.map(deal => {
    const p = deal.properties || {};
    const ownerId = p.hubspot_owner_id || null;
    return {
      id: deal.id,
      name: p.dealname || null,
      amount: parseFloat(p.amount) || null,
      stage: p.dealstage || null,
      close_date: p.closedate || null,
      pipeline: p.pipeline || null,
      is_closed_won: p.hs_is_closed_won === 'true' ? 1 : 0,
      is_closed_lost: p.hs_is_closed_lost === 'true' ? 1 : 0,
      owner_id: ownerId,
      owner_name: ownerId ? (ownersMap[ownerId] || null) : null
    };
  });
}

async function fetchCurrentContacts(hubspot) {
  const properties = [
    'firstname', 'lastname', 'email', 'company', 'jobtitle',
    'lifecyclestage', 'hs_lead_status'
  ];

  let allContacts = [];
  let after = undefined;

  do {
    const response = await hubspot.client.makeRequest('/crm/v3/objects/contacts', {
      params: {
        limit: 100,
        properties: properties.join(','),
        ...(after ? { after } : {})
      }
    });

    allContacts = allContacts.concat(response.results || []);
    after = response.paging?.next?.after;
  } while (after);

  return allContacts.map(c => {
    const p = c.properties || {};
    return {
      id: c.id,
      firstname: p.firstname || null,
      lastname: p.lastname || null,
      email: p.email || null,
      company: p.company || null,
      jobtitle: p.jobtitle || null,
      lifecyclestage: p.lifecyclestage || null,
      hs_lead_status: p.hs_lead_status || null
    };
  });
}

async function fetchRecentNotes(hubspot) {
  const response = await hubspot.client.makeRequest('/crm/v3/objects/notes/search', {
    method: 'POST',
    body: {
      filterGroups: [{
        filters: [{
          propertyName: 'hs_createdate',
          operator: 'GTE',
          value: new Date(Date.now() - 24 * 60 * 60 * 1000).getTime().toString()
        }]
      }],
      properties: ['hs_note_body', 'hs_createdate'],
      limit: 100
    }
  });

  const notes = response.results || [];
  const enriched = [];

  for (const note of notes) {
    // Fetch associations
    let contactId = null, companyId = null, dealId = null;
    try {
      const assoc = await hubspot.client.makeRequest(`/crm/v3/objects/notes/${note.id}/associations/contacts`);
      contactId = assoc.results?.[0]?.id || null;
    } catch {}
    try {
      const assoc = await hubspot.client.makeRequest(`/crm/v3/objects/notes/${note.id}/associations/companies`);
      companyId = assoc.results?.[0]?.id || null;
    } catch {}
    try {
      const assoc = await hubspot.client.makeRequest(`/crm/v3/objects/notes/${note.id}/associations/deals`);
      dealId = assoc.results?.[0]?.id || null;
    } catch {}

    const body = (note.properties.hs_note_body || '').replace(/<[^>]*>/g, '').slice(0, 500);

    enriched.push({
      id: note.id,
      body_preview: body,
      contact_id: contactId,
      company_id: companyId,
      deal_id: dealId,
      created_at: note.properties.hs_createdate || note.createdAt
    });
  }

  return enriched;
}

// --- Diff engines ---

function diffDeals(db, currentDeals) {
  const events = [];
  const oldDeals = new Map();

  const rows = db.prepare('SELECT * FROM deal_snapshot').all();
  for (const row of rows) {
    oldDeals.set(row.id, row);
  }

  for (const deal of currentDeals) {
    const old = oldDeals.get(deal.id);

    if (!old) {
      events.push({ type: 'deal_created', deal });
      continue;
    }

    if (old.stage !== deal.stage) {
      if ((deal.is_closed_won && !old.is_closed_won) || (deal.is_closed_lost && !old.is_closed_lost)) {
        events.push({ type: 'deal_closed', deal, won: !!deal.is_closed_won });
      } else {
        events.push({ type: 'deal_stage_changed', deal, oldStage: old.stage, newStage: deal.stage });
      }
    }

    if (old.amount !== deal.amount && (old.amount || deal.amount)) {
      events.push({ type: 'deal_amount_changed', deal, oldAmount: old.amount, newAmount: deal.amount });
    }
  }

  return events;
}

function diffContacts(db, currentContacts) {
  const events = [];
  const oldContacts = new Map();

  const rows = db.prepare('SELECT * FROM contact_snapshot').all();
  for (const row of rows) {
    oldContacts.set(row.id, row);
  }

  const trackedFields = ['email', 'company', 'jobtitle', 'lifecyclestage', 'hs_lead_status'];

  for (const contact of currentContacts) {
    const old = oldContacts.get(contact.id);

    if (!old) {
      events.push({ type: 'contact_created', contact });
      continue;
    }

    const changes = {};
    for (const field of trackedFields) {
      if ((old[field] || null) !== (contact[field] || null)) {
        changes[field] = { old: old[field], new: contact[field] };
      }
    }

    if (Object.keys(changes).length > 0) {
      events.push({ type: 'contact_updated', contact, changes });
    }
  }

  return events;
}

function diffNotes(db, currentNotes) {
  const events = [];
  const existingIds = new Set(
    db.prepare('SELECT id FROM note_snapshot').all().map(r => r.id)
  );

  for (const note of currentNotes) {
    if (!existingIds.has(note.id)) {
      events.push({ type: 'note_added', note });
    }
  }

  return events;
}

// --- Snapshot updaters ---

function updateDealSnapshot(db, deals) {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO deal_snapshot
      (id, name, amount, stage, close_date, pipeline, is_closed_won, is_closed_lost, owner_id, owner_name, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const transaction = db.transaction((items) => {
    for (const d of items) {
      upsert.run(d.id, d.name, d.amount, d.stage, d.close_date, d.pipeline, d.is_closed_won, d.is_closed_lost, d.owner_id, d.owner_name);
    }
  });
  transaction(deals);
}

function updateContactSnapshot(db, contacts) {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO contact_snapshot
      (id, firstname, lastname, email, company, jobtitle, lifecyclestage, hs_lead_status, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const transaction = db.transaction((items) => {
    for (const c of items) {
      upsert.run(c.id, c.firstname, c.lastname, c.email, c.company, c.jobtitle, c.lifecyclestage, c.hs_lead_status);
    }
  });
  transaction(contacts);
}

function updateNoteSnapshot(db, notes) {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO note_snapshot
      (id, body_preview, contact_id, company_id, deal_id, created_at, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const transaction = db.transaction((items) => {
    for (const n of items) {
      upsert.run(n.id, n.body_preview, n.contact_id, n.company_id, n.deal_id, n.created_at);
    }
  });
  transaction(notes);
}

// --- Resolve names for note context ---

async function resolveNoteContext(hubspot, note) {
  let contactName = null, companyName = null, dealName = null;

  if (note.contact_id) {
    try {
      const c = await hubspot.client.makeRequest(`/crm/v3/objects/contacts/${note.contact_id}`, {
        params: { properties: 'firstname,lastname' }
      });
      contactName = `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim() || null;
    } catch {}
  }
  if (note.company_id) {
    try {
      const c = await hubspot.client.makeRequest(`/crm/v3/objects/companies/${note.company_id}`, {
        params: { properties: 'name' }
      });
      companyName = c.properties.name || null;
    } catch {}
  }
  if (note.deal_id) {
    try {
      const d = await hubspot.client.makeRequest(`/crm/v3/objects/deals/${note.deal_id}`, {
        params: { properties: 'dealname' }
      });
      dealName = d.properties.dealname || null;
    } catch {}
  }

  return { contactName, companyName, dealName };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const init = args.includes('--init');

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('HUBSPOT_ACCESS_TOKEN not found in environment');
  }

  const hubspot = new HubSpotService({ accessToken });
  const db = openDb();

  // Fetch all current state
  console.log('Fetching current state from HubSpot...');
  const [currentDeals, currentContacts, currentNotes] = await Promise.all([
    fetchCurrentDeals(hubspot),
    fetchCurrentContacts(hubspot),
    fetchRecentNotes(hubspot)
  ]);
  console.log(`Fetched ${currentDeals.length} deals, ${currentContacts.length} contacts, ${currentNotes.length} recent notes`);

  if (init) {
    console.log('Initializing snapshots (no events will be posted)...');
    updateDealSnapshot(db, currentDeals);
    updateContactSnapshot(db, currentContacts);
    updateNoteSnapshot(db, currentNotes);
    console.log('Snapshots saved');
    db.close();
    return;
  }

  // Diff everything
  const dealEvents = diffDeals(db, currentDeals);
  const contactEvents = diffContacts(db, currentContacts);
  const noteEvents = diffNotes(db, currentNotes);
  const allEvents = [...dealEvents, ...contactEvents, ...noteEvents];

  if (allEvents.length === 0) {
    console.log('No changes detected');
    // Still update snapshots to keep timestamps fresh
    updateDealSnapshot(db, currentDeals);
    updateContactSnapshot(db, currentContacts);
    updateNoteSnapshot(db, currentNotes);
    db.close();
    return;
  }

  console.log(`Detected ${allEvents.length} change(s):`);
  for (const event of allEvents) {
    switch (event.type) {
      case 'deal_created':
        console.log(`  + Deal: ${event.deal.name}`);
        break;
      case 'deal_stage_changed':
        console.log(`  > Deal stage: ${event.deal.name} (${event.oldStage} -> ${event.newStage})`);
        break;
      case 'deal_amount_changed':
        console.log(`  $ Deal amount: ${event.deal.name} (${event.oldAmount} -> ${event.newAmount})`);
        break;
      case 'deal_closed':
        console.log(`  ${event.won ? 'W' : 'L'} Deal closed: ${event.deal.name}`);
        break;
      case 'contact_created':
        console.log(`  + Contact: ${event.contact.firstname} ${event.contact.lastname}`);
        break;
      case 'contact_updated':
        console.log(`  ~ Contact: ${event.contact.firstname} ${event.contact.lastname} (${Object.keys(event.changes).join(', ')})`);
        break;
      case 'note_added':
        console.log(`  + Note: ${event.note.body_preview?.slice(0, 60)}...`);
        break;
    }
  }

  if (dryRun) {
    console.log('\nDry run — nothing posted to Slack');
    db.close();
    return;
  }

  // Post to Slack
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('SLACK_WEBHOOK_URL not found in environment');
    db.close();
    process.exit(1);
  }

  const slack = new SlackClient(webhookUrl);
  let posted = 0;

  for (const event of allEvents) {
    let message;
    switch (event.type) {
      case 'deal_created':
        message = formatDealCreated(event.deal);
        break;
      case 'deal_stage_changed':
        message = formatStageChanged(event.deal, event.oldStage, event.newStage);
        break;
      case 'deal_amount_changed':
        message = formatAmountChanged(event.deal, event.oldAmount, event.newAmount);
        break;
      case 'deal_closed':
        message = formatDealClosed(event.deal, event.won);
        break;
      case 'contact_created':
        message = formatContactCreated(event.contact);
        break;
      case 'contact_updated':
        message = formatContactUpdated(event.contact, event.changes);
        break;
      case 'note_added': {
        const ctx = await resolveNoteContext(hubspot, event.note);
        message = formatNoteAdded({
          body: event.note.body_preview,
          contactName: ctx.contactName,
          companyName: ctx.companyName,
          dealName: ctx.dealName
        });
        break;
      }
    }

    if (message) {
      await slack.sendBlocks(message.blocks, message.text);
      posted++;
    }
  }

  console.log(`Posted ${posted} event(s) to Slack`);

  // Update all snapshots
  updateDealSnapshot(db, currentDeals);
  updateContactSnapshot(db, currentContacts);
  updateNoteSnapshot(db, currentNotes);
  console.log('Snapshots updated');

  db.close();
}

main().catch(err => {
  console.error(`Event sync failed: ${err.message}`);
  process.exit(1);
});
