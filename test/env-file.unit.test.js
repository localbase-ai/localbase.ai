import { describe, it } from 'node:test';
import assert from 'node:assert';
import { updateEnvContent } from '../tools/server/env-file.js';

const FILE = `# LocalBase — my workspace
# QuickBooks (rotates on every refresh)
QUICKBOOKS_CLIENT_ID=abc
QUICKBOOKS_REFRESH_TOKEN=old

# HubSpot
HUBSPOT_ACCESS_TOKEN=hs-1   # private app
# OLD_KEY=commented out on purpose
export GA4_PROPERTY=123
weird line the parser doesn't understand
`;

describe('updateEnvContent', () => {
  it('keeps comments, blank lines, order and unknown lines when updating a key', () => {
    const { content, updated } = updateEnvContent(FILE, { QUICKBOOKS_REFRESH_TOKEN: 'new' });
    assert.strictEqual(content, FILE.replace('QUICKBOOKS_REFRESH_TOKEN=old', 'QUICKBOOKS_REFRESH_TOKEN=new'));
    assert.strictEqual(updated, 1);
  });

  it('appends new keys at the end, keeping everything else', () => {
    const { content } = updateEnvContent(FILE, { MAPBOX_TOKEN: 'pk.1' });
    assert.strictEqual(content, FILE + 'MAPBOX_TOKEN=pk.1\n');
  });

  it('deletes only the line for a removed key', () => {
    const { content, deleted } = updateEnvContent(FILE, { HUBSPOT_ACCESS_TOKEN: null });
    assert.strictEqual(content, FILE.replace('HUBSPOT_ACCESS_TOKEN=hs-1   # private app\n', ''));
    assert.strictEqual(deleted, 1);
  });

  it('leaves commented-out keys alone', () => {
    const { content } = updateEnvContent(FILE, { OLD_KEY: 'x' });
    assert.ok(content.includes('# OLD_KEY=commented out on purpose'));
    assert.ok(content.endsWith('OLD_KEY=x\n'));
  });

  it('keeps an export prefix', () => {
    const { content } = updateEnvContent(FILE, { GA4_PROPERTY: '456' });
    assert.ok(content.includes('export GA4_PROPERTY=456\n'));
  });

  it('updates every duplicate so any loader sees the new value', () => {
    const { content } = updateEnvContent('A=1\nB=2\nA=3\n', { A: '9' });
    assert.strictEqual(content, 'A=9\nB=2\nA=9\n');
  });

  it('does not match a key that merely starts with the same name', () => {
    const { content } = updateEnvContent('API_KEY_OLD=1\n', { API_KEY: '2' });
    assert.strictEqual(content, 'API_KEY_OLD=1\nAPI_KEY=2\n');
  });

  it('ignores undefined and empty values', () => {
    const { content, updated } = updateEnvContent(FILE, { QUICKBOOKS_CLIENT_ID: '', X: undefined });
    assert.strictEqual(content, FILE);
    assert.strictEqual(updated, 0);
  });

  it('preserves CRLF line endings and a missing trailing newline', () => {
    assert.strictEqual(updateEnvContent('# c\r\nA=1\r\n', { A: '2' }).content, '# c\r\nA=2\r\n');
    assert.strictEqual(updateEnvContent('A=1', { A: '2' }).content, 'A=2');
    assert.strictEqual(updateEnvContent('A=1', { B: '2' }).content, 'A=1\nB=2\n');
  });

  it('starts a new file with the header', () => {
    const { content } = updateEnvContent('', { A: '1' });
    assert.match(content, /^# LocalBase environment variables\n# Do not commit this file to version control\n\nA=1\n$/);
  });
});
