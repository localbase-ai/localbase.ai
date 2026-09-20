import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isAllowedReadOnlySqlQuery, resolveWorkspaceDatabasePath } from '../tools/server/security-utils.js';

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
