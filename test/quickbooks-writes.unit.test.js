import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';

// test/ syncs into every workspace but connectors don't, so a workspace may
// have no QuickBooks connector or its own older copy. Run only against the
// framework's gated connector, which exports WRITE_TOOLS.
const mod = await import('../connectors/quickbooks/index.js').catch(() => null);
const skip = !mod?.WRITE_TOOLS && 'no framework QuickBooks connector in this workspace';
const { QuickBooksConnector } = mod || {};

const WRITES = ['quickbooks_create_customer', 'quickbooks_update_customer'];

describe('QuickBooks write tools are opt-in', { skip }, () => {
  afterEach(() => { delete process.env.QUICKBOOKS_ENABLE_WRITES; });

  it('hides write tools by default', async () => {
    const names = (await new QuickBooksConnector().getTools()).map(t => t.name);
    for (const w of WRITES) assert.ok(!names.includes(w), w);
    assert.ok(names.includes('quickbooks_list_customers'));
  });

  it('refuses a write call by default, before touching the API', async () => {
    await assert.rejects(new QuickBooksConnector().handleTool('quickbooks_create_customer', { displayName: 'x' }), /disabled/);
  });

  it('exposes write tools when QUICKBOOKS_ENABLE_WRITES=true', async () => {
    process.env.QUICKBOOKS_ENABLE_WRITES = 'true';
    const names = (await new QuickBooksConnector().getTools()).map(t => t.name);
    for (const w of WRITES) assert.ok(names.includes(w), w);
  });
});
