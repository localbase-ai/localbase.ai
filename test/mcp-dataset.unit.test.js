import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveDatasetCsv } from '../tools/mcp/dataset.js';

describe('MCP resolveDatasetCsv', () => {
  let root, data;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'lb-mcp-'));
    data = join(root, 'data');
    mkdirSync(join(data, 'sales'), { recursive: true });
    mkdirSync(join(data, 'quickbooks'), { recursive: true });
    writeFileSync(join(data, 'sales', 'orders.csv'), 'id\n1\n');
    writeFileSync(join(data, 'leads.csv'), 'id\n1\n');
    writeFileSync(join(data, 'quickbooks', 'tokens.json'), '{"access_token":"x"}');
    writeFileSync(join(root, 'env.local'), 'SECRET=1\n');
    writeFileSync(join(root, 'outside.csv'), 'id\n1\n');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('resolves a dataset directory to its first CSV', async () => {
    const r = await resolveDatasetCsv(data, 'sales');
    assert.strictEqual(r.filePath, join(data, 'sales', 'orders.csv'));
    assert.strictEqual(r.isDirectory, true);
  });

  it('resolves a bare name to name.csv', async () => {
    const r = await resolveDatasetCsv(data, 'leads');
    assert.strictEqual(r.filePath, join(data, 'leads.csv'));
  });

  it('refuses to read env.local by traversal', async () => {
    await assert.rejects(resolveDatasetCsv(data, '../env.local'));
  });

  it('refuses a CSV outside data/', async () => {
    await assert.rejects(resolveDatasetCsv(data, '../outside'));
    await assert.rejects(resolveDatasetCsv(data, '../outside.csv'));
  });

  it('refuses absolute paths', async () => {
    await assert.rejects(resolveDatasetCsv(data, join(root, 'env.local')));
  });

  it('refuses non-CSV files inside data/, including tokens', async () => {
    await assert.rejects(resolveDatasetCsv(data, 'quickbooks/tokens.json'));
  });

  it('refuses non-string input', async () => {
    await assert.rejects(resolveDatasetCsv(data, ['sales']));
    await assert.rejects(resolveDatasetCsv(data, ''));
  });
});
