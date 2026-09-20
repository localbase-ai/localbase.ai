/**
 * Connector API Tests
 *
 * Tests connector listing, installation, and credential management.
 * Run with: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { startTestServer, stopTestServer, request } from './setup.js';

before(async () => {
  await startTestServer();
});

after(async () => {
  await stopTestServer();
});

// ============================================================================
// Connector Listing
// ============================================================================

describe('Connector Listing', () => {

  it('should return connectors list', async () => {
    const res = await request('/api/connectors');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert(Array.isArray(res.data.connectors), 'connectors should be an array');
  });

  it('should include connector status and lastSync', async () => {
    const res = await request('/api/connectors');
    assert.strictEqual(res.status, 200);

    if (res.data.connectors.length > 0) {
      const connector = res.data.connectors[0];
      assert('status' in connector, 'connector should have status');
      assert('lastSync' in connector, 'connector should have lastSync');
      assert('id' in connector, 'connector should have id');
      assert('name' in connector, 'connector should have name');
    }
  });

});

// ============================================================================
// Connector Installation
// ============================================================================

describe('Connector Installation', () => {

  it('should reject install without connectorId', async () => {
    const res = await request('/api/connectors/install', {
      method: 'POST',
      body: {}
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.success, false);
    assert(res.data.error.includes('connectorId'), 'error should mention connectorId');
  });

  it('should return 404 for non-existent connector template', async () => {
    const res = await request('/api/connectors/install', {
      method: 'POST',
      body: { connectorId: 'nonexistent-connector-xyz' }
    });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.data.success, false);
  });

});

// ============================================================================
// Environment Variable Saving
// ============================================================================

describe('Environment Variable Saving', () => {

  // /api/env/save writes to the LIVE workspace env.local. Snapshot it and put
  // it back afterwards so running the suite never mutates real credentials.
  // Without this, every run left a permanent TEST_VAR_<timestamp> line behind —
  // and the pre-commit hook runs the suite, so every commit added one.
  const envPath = join(process.cwd(), 'env.local');
  let envSnapshot = null;
  let envExisted = false;

  before(() => {
    envExisted = existsSync(envPath);
    if (envExisted) envSnapshot = readFileSync(envPath, 'utf-8');
  });

  after(() => {
    if (envExisted) writeFileSync(envPath, envSnapshot);
    else if (existsSync(envPath)) rmSync(envPath);
  });

  it('should reject save without vars object', async () => {
    const res = await request('/api/env/save', {
      method: 'POST',
      body: {}
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.success, false);
  });

  it('should reject save with non-object vars', async () => {
    const res = await request('/api/env/save', {
      method: 'POST',
      body: { vars: 'not-an-object' }
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.success, false);
  });

  it('should save environment variables', async () => {
    // Fixed name, not TEST_VAR_${Date.now()} — a unique name per run made the
    // residue accumulate forever instead of overwriting a single line.
    const res = await request('/api/env/save', {
      method: 'POST',
      body: { vars: { TEST_VAR: 'test-value' } }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
  });

});

// ============================================================================
// Workspace Connector Validation
// ============================================================================

describe('Workspace Connectors', () => {

  it('should have valid structure for all listed connectors', async () => {
    const res = await request('/api/connectors');
    assert.strictEqual(res.status, 200);
    for (const connector of res.data.connectors) {
      assert('id' in connector, `connector should have id`);
      assert('status' in connector, `${connector.id} should have status`);
    }
  });

});

// ============================================================================
// Data Sources
// ============================================================================

describe('Data Sources', () => {

  it('should return data sources', async () => {
    const res = await request('/api/datasources');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert('sources' in res.data, 'response should have sources');
  });

});

// ============================================================================
// Connector Logo Endpoint
// ============================================================================

describe('Connector Logo', () => {
  // Set up two fixture connectors so the test is self-contained instead of
  // depending on a specific instance shipping (or not shipping) certain
  // connectors. Previously hardcoded "hubspot" which not every instance has.
  const FIXTURE_WITH_LOGO = 'test-logo-svg-fixture';
  const FIXTURE_NO_LOGO = 'test-no-logo-fixture';
  let workspacePath;
  let withLogoDir;
  let noLogoDir;

  before(async () => {
    const r = await request('/api/workspace');
    workspacePath = r.data?.path;
    if (!workspacePath) {
      throw new Error('Could not resolve workspace path from /api/workspace');
    }
    withLogoDir = join(workspacePath, 'connectors', FIXTURE_WITH_LOGO);
    noLogoDir = join(workspacePath, 'connectors', FIXTURE_NO_LOGO);

    mkdirSync(withLogoDir, { recursive: true });
    writeFileSync(
      join(withLogoDir, 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
    );

    mkdirSync(noLogoDir, { recursive: true });
  });

  after(() => {
    if (withLogoDir) rmSync(withLogoDir, { recursive: true, force: true });
    if (noLogoDir) rmSync(noLogoDir, { recursive: true, force: true });
  });

  it('should serve a connector logo as image/svg+xml', async () => {
    const res = await request(`/api/connectors/${FIXTURE_WITH_LOGO}/logo`);
    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get('content-type') || '';
    assert(contentType.includes('image/svg+xml'), `expected svg, got ${contentType}`);
  });

  it('should return 404 for connector without a logo', async () => {
    const res = await request(`/api/connectors/${FIXTURE_NO_LOGO}/logo`);
    assert.strictEqual(res.status, 404);
  });

  it('should reject path traversal attempts', async () => {
    // ".." in URLs is blocked by middleware before reaching the handler,
    // returning 403; the handler's CONNECTOR_ID_REGEX would otherwise return 400.
    // Either response indicates the attack was rejected.
    const res = await request('/api/connectors/bad..id/logo');
    assert.ok(
      res.status === 400 || res.status === 403,
      `Expected 400 or 403 for path traversal, got ${res.status}`
    );
  });

});
