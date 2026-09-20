/**
 * API Tests for LocalBase Server
 *
 * Tests core API endpoints for workspace, tools, and connectors.
 * Run with: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, stopTestServer, request } from './setup.js';

before(async () => {
  await startTestServer();
});

after(async () => {
  await stopTestServer();
});

// ============================================================================
// Health Check
// ============================================================================

describe('Health Check', () => {

  it('should return 200 on /health', async () => {
    const res = await request('/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'ok');
  });

});

// ============================================================================
// Workspace API
// ============================================================================

describe('Workspace API', () => {

  it('GET /api/workspace should return workspace info', async () => {
    const res = await request('/api/workspace');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.success !== undefined || res.data.name !== undefined);
  });

  it('GET /api/workspaces should return workspaces list', async () => {
    const res = await request('/api/workspaces');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.success !== undefined || Array.isArray(res.data.workspaces));
  });

  it('GET /api/workspace/stats should return statistics', async () => {
    const res = await request('/api/workspace/stats');
    assert.strictEqual(res.status, 200);
    // Should have some stats structure
    assert.ok(typeof res.data === 'object');
  });

  it('GET /api/workspace/framework-stats should return stats', async () => {
    const res = await request('/api/workspace/framework-stats');
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.data === 'object');
  });

  it('GET /api/workspace/node-modules-breakdown should return breakdown', async () => {
    const res = await request('/api/workspace/node-modules-breakdown');
    // 200 (found) or 404 (no node_modules in test cwd) — both are valid responses.
    assert.ok(res.status === 200 || res.status === 404);
  });

  it('POST /api/workspace/switch should require a path', async () => {
    const res = await request('/api/workspace/switch', {
      method: 'POST',
      body: {}
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.success, false);
  });

  it('POST /api/workspace/switch should reject non-LocalBase paths', async () => {
    const res = await request('/api/workspace/switch', {
      method: 'POST',
      body: { path: '/tmp' }
    });
    // 404 (not a workspace) or 400 (sanitize failure) — either is correct
    assert.ok(res.status === 400 || res.status === 404);
    assert.strictEqual(res.data.success, false);
  });

});

// ============================================================================
// Tools API
// ============================================================================

describe('Tools API', () => {

  it('GET /api/tools should return tools list', async () => {
    const res = await request('/api/tools');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.success === true || Array.isArray(res.data.tools));
  });

  it('GET /api/connectors should return connectors list', async () => {
    const res = await request('/api/connectors');
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.data === 'object');
  });

  it('GET /api/datasources should return datasources', async () => {
    const res = await request('/api/datasources');
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.data === 'object');
  });

});

// ============================================================================
// Database Query API
// ============================================================================

describe('Database Query API', () => {

  it('POST /api/db/query should require database and sql', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      body: {}
    });
    // Should return 400 for missing params
    assert.ok(res.status === 400 || res.status === 404);
  });

  it('POST /api/db/query should reject non-SELECT queries', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      body: {
        database: 'data/test.db',
        sql: 'DELETE FROM users'
      }
    });
    // Should reject destructive queries (or 404 if db doesn't exist)
    assert.ok(
      res.status === 400 || res.status === 403 || res.status === 404 || res.status === 500,
      `Expected 400/403/404/500, got ${res.status}`
    );
  });

  it('POST /api/db/query should accept SELECT queries', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      body: {
        database: 'data/test.db',
        sql: 'SELECT 1 as test'
      }
    });
    // Should succeed or 404 if db doesn't exist
    assert.ok(
      res.status === 200 || res.status === 404,
      `Expected 200 or 404, got ${res.status}`
    );
  });

  it('POST /api/db/query should allow read-only CTE queries', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      body: {
        database: 'data/test.db',
        sql: 'WITH sample AS (SELECT 1 AS test) SELECT test FROM sample'
      }
    });
    assert.ok(
      res.status === 200 || res.status === 404,
      `Expected 200 or 404, got ${res.status}`
    );
  });

});

