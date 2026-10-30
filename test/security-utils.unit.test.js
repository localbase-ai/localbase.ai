import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isAllowedReadOnlySqlQuery, isLoopbackHost, isSensitiveWorkspacePath, isSensitiveWorkspaceRequest, resolveWorkspaceDatabasePath } from '../tools/server/security-utils.js';

describe('Server Security Utilities', () => {
  describe('isAllowedReadOnlySqlQuery', () => {
    it('allows plain SELECT queries', () => {
      assert.strictEqual(isAllowedReadOnlySqlQuery('SELECT 1'), true);
    });

    it('allows read-only CTE queries', () => {
      assert.strictEqual(
        isAllowedReadOnlySqlQuery('WITH sample AS (SELECT 1 AS value) SELECT value FROM sample'),
        true
      );
    });

    it('rejects mutating CTE queries', () => {
      assert.strictEqual(
        isAllowedReadOnlySqlQuery('WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed'),
        false
      );
    });
  });

  describe('resolveWorkspaceDatabasePath', () => {
    it('keeps database paths inside workspace data dir', () => {
      const result = resolveWorkspaceDatabasePath('/tmp/workspace', 'data/reports/metrics.db');
      assert.strictEqual(result.dbPath, '/tmp/workspace/data/reports/metrics.db');
    });

    it('rejects database paths outside workspace data dir', () => {
      assert.throws(
        () => resolveWorkspaceDatabasePath('/tmp/workspace', 'connectors/secrets.db'),
        /workspace data directory/
      );
    });
  });
});

describe('isLoopbackHost', () => {
  it('accepts loopback names with and without a port', () => {
    for (const h of ['localhost', 'localhost:9220', '127.0.0.1:9221', '127.1.2.3', '[::1]:9220', '[::1]', 'app.localhost:9221', 'LOCALHOST:9220']) {
      assert.strictEqual(isLoopbackHost(h), true, h);
    }
  });

  it('rejects rebinding hosts and lookalikes', () => {
    for (const h of ['evil.example:9220', 'localhost.evil.example', '127.0.0.1.evil.example', '192.168.1.5:9220', '0.0.0.0:9220', '[::2]:9220', '', undefined]) {
      assert.strictEqual(isLoopbackHost(h), false, String(h));
    }
  });
});

describe('isSensitiveWorkspacePath', () => {
  it('blocks credential files anywhere in the workspace', () => {
    for (const p of [
      'data/quickbooks/tokens.json', '/data/jobber/tokens.json', 'data/x/TOKENS.JSON', 'data/x/token.json',
      'connectors/google/oauth-credentials.json', 'connectors/x/client_secret_123.json',
      'env.local', 'env.local.bak', '.env.production', 'data/x/server.pem', 'data/x/id.key',
      'projects/foo/auth.json', '.git/config', 'connectors/gmail/gmail_token.json', 'data/x/foo.token.json', 'gmail_credentials.json', 'refresh_token.txt', 'service-account.json', 'k.p12', 'data/preview/anything.txt', 'data/preview/', './data/preview/x.txt', 'data/./preview/x.txt',
      'data/google/oauth-client.json', 'data/google/anything.json', 'data/callrail/salt',
      'data/google-ads/tokens.json.4242.tmp', 'data/google-analytics/tokens.json.testbackup'
    ]) {
      assert.strictEqual(isSensitiveWorkspacePath(p), true, p);
    }
  });

  it('allows the data files vizzes load', () => {
    for (const p of ['data/hubspot/hubspot-deals.sqlite', 'data/campaigns/campaigns.db', 'data/mixpanel/daily.json', 'projects/example/data.json', 'data/token-usage/summary.json', 'data/salt-sales/x.db', 'data/google-ads/ads.db']) {
      assert.strictEqual(isSensitiveWorkspacePath(p), false, p);
    }
  });

  it('treats non-strings as sensitive', () => {
    assert.strictEqual(isSensitiveWorkspacePath(['a', 'b']), true);
  });
});

describe('isSensitiveWorkspaceRequest', () => {
  let ws, outside;
  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'lb-ws-'));
    outside = mkdtempSync(join(tmpdir(), 'lb-outside-'));
    mkdirSync(join(ws, 'data', 'x'), { recursive: true });
    writeFileSync(join(ws, 'data', 'x', 'tokens.json'), '{}');
    writeFileSync(join(ws, 'data', 'x', 'salt'), 's');
    writeFileSync(join(ws, 'data', 'x', 'daily.json'), '{}');
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'data', 'x', 'notes.txt'));
    symlinkSync(join(ws, 'data', 'x', 'tokens.json'), join(ws, 'data', 'x', 'innocent.txt'));
  });
  after(() => { rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

  it('allows ordinary data files', () => {
    assert.strictEqual(isSensitiveWorkspaceRequest(ws, '/data/x/daily.json'), false);
  });

  it('blocks symlinks that leave the workspace or point at a credential', () => {
    assert.strictEqual(isSensitiveWorkspaceRequest(ws, '/data/x/notes.txt'), true);
    assert.strictEqual(isSensitiveWorkspaceRequest(ws, '/data/x/innocent.txt'), true);
  });

  it('blocks look-alike spellings the filesystem folds onto a credential', (t) => {
    // Only meaningful where the filesystem folds them (macOS); elsewhere the
    // look-alike name simply doesn't exist and there's nothing to serve.
    const lookalikes = ['/data/x/tokens.j\u017Fon', '/data/x/to\u212Aens.json', '/data/x/\u017Falt'];
    if (!existsSync(join(ws, lookalikes[0]))) return t.skip('filesystem does not fold Unicode look-alikes');
    for (const p of lookalikes) assert.strictEqual(isSensitiveWorkspaceRequest(ws, p), true, p);
  });
});
