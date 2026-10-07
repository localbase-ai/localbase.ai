import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isAllowedReadOnlySqlQuery, isLoopbackHost, isSensitiveWorkspacePath, resolveWorkspaceDatabasePath } from '../tools/server/security-utils.js';

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
      'projects/foo/auth.json', '.git/config', 'connectors/gmail/gmail_token.json', 'data/x/foo.token.json', 'gmail_credentials.json', 'refresh_token.txt', 'service-account.json', 'k.p12', 'data/preview/anything.txt', 'data/preview/', './data/preview/x.txt', 'data/./preview/x.txt'
    ]) {
      assert.strictEqual(isSensitiveWorkspacePath(p), true, p);
    }
  });

  it('allows the data files vizzes load', () => {
    for (const p of ['data/hubspot/hubspot-deals.sqlite', 'data/campaigns/campaigns.db', 'data/mixpanel/daily.json', 'projects/example/data.json', 'data/token-usage/summary.json']) {
      assert.strictEqual(isSensitiveWorkspacePath(p), false, p);
    }
  });

  it('treats non-strings as sensitive', () => {
    assert.strictEqual(isSensitiveWorkspacePath(['a', 'b']), true);
  });
});
