/**
 * Slack Event Formatters
 * Formats HubSpot deal, contact, and note events into rich Slack messages
 */

const STAGE_COLORS = {
  // Common HubSpot deal stages — adjust to match your pipeline
  'appointmentscheduled': '#3498db',
  'qualifiedtobuy': '#2ecc71',
  'presentationscheduled': '#9b59b6',
  'decisionmakerboughtin': '#e67e22',
  'contractsent': '#f39c12',
  'closedwon': '#27ae60',
  'closedlost': '#e74c3c',
};

function stageColor(stage) {
  return STAGE_COLORS[stage] || '#95a5a6';
}

function formatCurrency(amount) {
  if (!amount && amount !== 0) return 'N/A';
  return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function stageName(stage) {
  if (!stage) return 'Unknown';
  return stage
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .replace(/closedwon/i, 'Closed Won')
    .replace(/closedlost/i, 'Closed Lost');
}

export function formatDealCreated(deal) {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:new: *New Deal Created*\n*${deal.name}*`
        }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Amount:* ${formatCurrency(deal.amount)}` },
          { type: 'mrkdwn', text: `*Stage:* ${stageName(deal.stage)}` },
          ...(deal.owner_name ? [{ type: 'mrkdwn', text: `*Owner:* ${deal.owner_name}` }] : []),
          ...(deal.close_date ? [{ type: 'mrkdwn', text: `*Close Date:* ${deal.close_date.split('T')[0]}` }] : [])
        ]
      }
    ],
    text: `New deal: ${deal.name} (${formatCurrency(deal.amount)})`
  };
}

export function formatStageChanged(deal, oldStage, newStage) {
  const isWon = newStage === 'closedwon';
  const isLost = newStage === 'closedlost';
  const emoji = isWon ? ':trophy:' : isLost ? ':x:' : ':arrow_right:';

  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *Stage Changed*\n*${deal.name}*\n${stageName(oldStage)} → ${stageName(newStage)}`
        }
      },
      ...(deal.amount ? [{
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `${formatCurrency(deal.amount)}${deal.owner_name ? ` | ${deal.owner_name}` : ''}` }
        ]
      }] : [])
    ],
    text: `${deal.name}: ${stageName(oldStage)} → ${stageName(newStage)}`
  };
}

export function formatAmountChanged(deal, oldAmount, newAmount) {
  const diff = (newAmount || 0) - (oldAmount || 0);
  const emoji = diff > 0 ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';

  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *Amount Changed*\n*${deal.name}*\n${formatCurrency(oldAmount)} → ${formatCurrency(newAmount)}`
        }
      },
      ...(deal.owner_name ? [{
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `${deal.owner_name} | ${stageName(deal.stage)}` }
        ]
      }] : [])
    ],
    text: `${deal.name}: ${formatCurrency(oldAmount)} → ${formatCurrency(newAmount)}`
  };
}

export function formatDealClosed(deal, won) {
  const emoji = won ? ':tada:' : ':no_entry_sign:';
  const status = won ? 'Closed Won' : 'Closed Lost';

  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${status}*\n*${deal.name}* — ${formatCurrency(deal.amount)}`
        }
      },
      ...(deal.owner_name ? [{
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: deal.owner_name }
        ]
      }] : [])
    ],
    text: `${status}: ${deal.name} (${formatCurrency(deal.amount)})`
  };
}

// --- Contact Formatters ---

export function formatContactCreated(contact) {
  const name = `${contact.firstname || ''} ${contact.lastname || ''}`.trim() || 'Unknown';
  const fields = [
    contact.email ? { type: 'mrkdwn', text: `*Email:* ${contact.email}` } : null,
    contact.company ? { type: 'mrkdwn', text: `*Company:* ${contact.company}` } : null,
    contact.jobtitle ? { type: 'mrkdwn', text: `*Title:* ${contact.jobtitle}` } : null
  ].filter(Boolean);

  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:bust_in_silhouette: *New Contact*\n*${name}*`
        }
      },
      ...(fields.length > 0 ? [{
        type: 'section',
        fields
      }] : [])
    ],
    text: `New contact: ${name}${contact.company ? ` (${contact.company})` : ''}`
  };
}

export function formatContactUpdated(contact, changes) {
  const name = `${contact.firstname || ''} ${contact.lastname || ''}`.trim() || 'Unknown';
  const changeLines = Object.entries(changes)
    .map(([field, { old: oldVal, new: newVal }]) => `*${field}:* ${oldVal || 'empty'} → ${newVal}`)
    .join('\n');

  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:pencil2: *Contact Updated*\n*${name}*\n${changeLines}`
        }
      }
    ],
    text: `Contact updated: ${name}`
  };
}

// --- Note Formatter ---

export function formatNoteAdded(note) {
  const preview = (note.body || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\*\*/g, '')
    .slice(0, 300);
  const truncated = preview.length < (note.body || '').replace(/<[^>]*>/g, '').replace(/\*\*/g, '').length ? preview + '...' : preview;

  const context = [note.contactName, note.companyName, note.dealName].filter(Boolean).join(' | ');

  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:memo: *Note Added*${context ? `\n*${context}*` : ''}`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: truncated || '_Empty note_'
        }
      }
    ],
    text: `Note added${context ? `: ${context}` : ''}`
  };
}
