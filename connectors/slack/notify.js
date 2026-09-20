#!/usr/bin/env node

/**
 * Slack Real-Time Notifier
 * Posts HubSpot events to Slack immediately after they happen.
 *
 * Usage as module:
 *   import { notifyDealCreated, notifyNoteAdded, notifyContactUpdated } from './notify.js';
 *   await notifyDealCreated(deal);
 *
 * Usage as CLI:
 *   node notify.js deal-created <dealId>
 *   node notify.js note-added <noteId> --contact <contactId>
 *   node notify.js contact-updated <contactId>
 */

import { SlackClient } from './client.js';
import {
  formatDealCreated,
  formatStageChanged,
  formatNoteAdded,
  formatContactCreated,
  formatContactUpdated
} from './index.js';
import dotenv from 'dotenv';

dotenv.config({ path: 'env.local' });

function getSlack() {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error('SLACK_WEBHOOK_URL not found in env.local');
  return new SlackClient(url);
}

async function send(message) {
  const slack = getSlack();
  await slack.sendBlocks(message.blocks, message.text);
}

/**
 * Notify Slack that a new deal was created
 * @param {Object} deal - { name, amount, stage, owner_name, close_date }
 */
export async function notifyDealCreated(deal) {
  await send(formatDealCreated(deal));
}

/**
 * Notify Slack that a deal changed stage
 * @param {Object} deal - { name, amount, owner_name }
 * @param {string} oldStage
 * @param {string} newStage
 */
export async function notifyStageChanged(deal, oldStage, newStage) {
  await send(formatStageChanged(deal, oldStage, newStage));
}

/**
 * Notify Slack that a note was added to a contact/deal
 * @param {Object} note - { body, contactName, companyName, dealName, timestamp }
 */
export async function notifyNoteAdded(note) {
  await send(formatNoteAdded(note));
}

/**
 * Notify Slack that a new contact was created
 * @param {Object} contact - { firstname, lastname, email, company, jobtitle }
 */
export async function notifyContactCreated(contact) {
  await send(formatContactCreated(contact));
}

/**
 * Notify Slack that a contact was updated
 * @param {Object} contact - { firstname, lastname, email, company, jobtitle }
 * @param {Object} changes - { field: { old, new } }
 */
export async function notifyContactUpdated(contact, changes) {
  await send(formatContactUpdated(contact, changes));
}

// --- CLI entrypoint ---
async function main() {
  const [command, id, ...rest] = process.argv.slice(2);

  if (!command) {
    console.log('Usage: node notify.js <command> <id> [options]');
    console.log('  deal-created <dealId>');
    console.log('  note-added <noteId> --contact <contactId>');
    console.log('  contact-updated <contactId>');
    process.exit(0);
  }

  // Lazy-load HubSpot client only when running as CLI
  const { HubSpotClient } = await import('../hubspot/client.js');
  const hs = new HubSpotClient({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });

  switch (command) {
    case 'deal-created': {
      const deal = await hs.makeRequest(`/crm/v3/objects/deals/${id}`, {
        params: { properties: 'dealname,amount,dealstage,closedate,hubspot_owner_id' }
      });
      const p = deal.properties;
      await notifyDealCreated({
        name: p.dealname,
        amount: parseFloat(p.amount) || null,
        stage: p.dealstage,
        close_date: p.closedate
      });
      console.log(`Posted deal-created for: ${p.dealname}`);
      break;
    }

    case 'note-added': {
      const note = await hs.makeRequest(`/crm/v3/objects/notes/${id}`, {
        params: { properties: 'hs_note_body,hs_timestamp', associations: 'contacts,companies,deals' }
      });
      const contactId = rest.includes('--contact') ? rest[rest.indexOf('--contact') + 1] : null;
      let contactName = null;
      let companyName = null;

      if (contactId) {
        const contact = await hs.makeRequest(`/crm/v3/objects/contacts/${contactId}`, {
          params: { properties: 'firstname,lastname,company' }
        });
        contactName = `${contact.properties.firstname || ''} ${contact.properties.lastname || ''}`.trim();
        companyName = contact.properties.company;
      }

      await notifyNoteAdded({
        body: note.properties.hs_note_body,
        contactName,
        companyName,
        timestamp: note.properties.hs_timestamp
      });
      console.log(`Posted note-added for: ${contactName || id}`);
      break;
    }

    case 'contact-updated': {
      const contact = await hs.makeRequest(`/crm/v3/objects/contacts/${id}`, {
        params: { properties: 'firstname,lastname,email,company,jobtitle' }
      });
      const p = contact.properties;
      await notifyContactCreated({
        firstname: p.firstname,
        lastname: p.lastname,
        email: p.email,
        company: p.company,
        jobtitle: p.jobtitle
      });
      console.log(`Posted contact event for: ${p.firstname} ${p.lastname}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

// Run CLI if invoked directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain) {
  main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
