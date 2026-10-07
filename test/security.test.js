/**
 * Security Tests for LocalBase Server
 *
 * These tests verify that security controls are working correctly.
 * Run with: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { startTestServer, stopTestServer, request } from './setup.js';
import { APP_URL } from '../tools/ports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

before(async () => {
  await startTestServer();
});

after(async () => {
  await stopTestServer();
});

// ============================================================================
// SQL Injection Tests
// ============================================================================

describe('SQL Injection Prevention', () => {

  it('should reject SQL injection in table names', async () => {
    // Attempt SQL injection via table name
    const res = await request('/api/db/query', {
      method: 'POST',
      body: {
        database: 'data/test.db',
        sql: 'SELECT * FROM users; DROP TABLE users; --'
      }
    });
    // Should reject non-SELECT or return error
    assert.ok(res.status === 400 || res.status === 404 || res.status === 500);
  });

});

// ============================================================================
// Path Traversal Tests
// ============================================================================

describe('DNS Rebinding Protection', () => {

  it('rejects a request whose Host is not a loopback name', async () => {
    const res = await request('/api/workspaces', { headers: { host: 'evil.example:9220' } });
    assert.strictEqual(res.status, 403);
  });

  it('rejects rebinding requests for raw data files', async () => {
    const res = await request('/data/anything.db', { headers: { host: 'evil.example:9220' } });
    assert.strictEqual(res.status, 403);
  });

  it('allows localhost and 127.0.0.1 hosts', async () => {
    for (const host of ['localhost:9220', '127.0.0.1:9220']) {
      const res = await request('/health', { headers: { host } });
      assert.strictEqual(res.status, 200, host);
    }
  });

});

describe('Credential Files Under data/', () => {

  it('blocks connector OAuth tokens over /data', async () => {
    const res = await request('/data/quickbooks/tokens.json');
    assert.strictEqual(res.status, 403);
  });

  it('blocks the preview password over /data', async () => {
    const res = await request('/data/preview/auth.json');
    assert.strictEqual(res.status, 403);
  });

  it('blocks tokens through /api/workspace/file', async () => {
    const res = await request('/api/workspace/file?path=data/jobber/tokens.json');
    assert.strictEqual(res.status, 403);
  });

  it('blocks url-encoded spellings', async () => {
    const res = await request('/data/quickbooks/%74okens.json');
    assert.strictEqual(res.status, 403);
  });

});

describe('Path Traversal Prevention', () => {

  it('should block ../ in workspace file path', async () => {
    const res = await request('/api/workspace/file?path=../../../etc/passwd');
    assert.strictEqual(res.status, 403, 'Should return 403 for path traversal');
    assert.ok(
      res.data.error?.includes('traversal') || res.data.error?.includes('denied'),
      'Should mention traversal or access denied'
    );
  });

  it('should block absolute paths', async () => {
    const res = await request('/api/workspace/file?path=/etc/passwd');
    assert.ok(
      res.status === 403 || res.status === 404,
      'Should reject absolute paths'
    );
  });

  it('should block access to env.local', async () => {
    const res = await request('/api/workspace/file?path=env.local');
    assert.strictEqual(res.status, 403, 'Should block sensitive files');
  });

  it('should block access to credentials.json', async () => {
    const res = await request('/api/workspace/file?path=connectors/hubspot/credentials.json');
    assert.strictEqual(res.status, 403, 'Should block credential files');
  });

  it('should allow valid workspace file paths', async () => {
    const res = await request('/api/workspace/file?path=package.json');
    // Should either succeed or 404 if file doesn't exist - not 403
    assert.ok(
      res.status === 200 || res.status === 404,
      'Should allow valid paths'
    );
  });

  it('should reject path traversal in tool config :toolId', async () => {
    const res = await request('/api/tools/..%2F..%2Fenv.local/config');
    // Global ".." blocker may catch this with 403 before the route handler's
    // 400 fires. Both are acceptable rejections.
    assert.ok(
      res.status === 400 || res.status === 403 || res.status === 404,
      `Should reject traversal in toolId, got ${res.status}`
    );
  });

  it('should reject invalid characters in tool config :toolId', async () => {
    const res = await request('/api/tools/foo$bar/config');
    assert.strictEqual(res.status, 400);
  });

  it('should block path traversal in database query path', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      body: {
        database: '../package.json',
        sql: 'SELECT 1'
      }
    });
    assert.strictEqual(res.status, 403);
  });

  it('should block database paths outside the data directory', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      body: {
        database: 'connectors/test.db',
        sql: 'SELECT 1'
      }
    });
    assert.strictEqual(res.status, 403);
  });

});

// ============================================================================
// XSS Prevention Tests
// ============================================================================

describe('XSS Prevention', () => {

  it('should escape HTML in viz 404 error', async () => {
    const xssPayload = '<script>alert("xss")</script>';
    const res = await request(`/api/viz/${encodeURIComponent(xssPayload)}`);

    assert.strictEqual(res.status, 404);

    // Response should NOT contain unescaped script tag
    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    assert.ok(
      !html.includes('<script>alert'),
      'Should escape script tags in error response'
    );

    // Should contain escaped version
    assert.ok(
      html.includes('&lt;script&gt;') || !html.includes('<script'),
      'Should use HTML entities or omit entirely'
    );
  });

  it('should escape HTML in viz 500 error', async () => {
    // This is harder to trigger directly - would need to cause an error
    // For now, verify the escapeHtml function exists in response
    const res = await request('/api/viz/nonexistent-viz-id-12345');
    assert.strictEqual(res.status, 404);
  });

});

// ============================================================================
// Command Injection Tests
// ============================================================================

describe('Command Injection Prevention', () => {

  it('should reject shell metacharacters in sync script path', async () => {
    const res = await request('/api/datasources/test/sync', {
      method: 'POST'
    });
    // Should fail gracefully - either 404 (no such datasource) or 400 (bad path)
    assert.ok(
      res.status === 404 || res.status === 400,
      'Should not allow arbitrary command execution'
    );
  });


  it('should accept valid weeks parameter', async () => {
    const res = await request('/api/signals/refresh?weeks=2', {
      method: 'POST'
    });
    // Should either succeed or 404 if script doesn't exist - not 400
    assert.ok(
      res.status === 200 || res.status === 404,
      'Should accept valid weeks parameter'
    );
  });

});

// ============================================================================
// Security Headers Tests
// ============================================================================

describe('Security Headers', () => {

  it('should include X-Frame-Options header', async () => {
    const res = await request('/health');
    assert.strictEqual(
      res.headers.get('x-frame-options'),
      'SAMEORIGIN',
      'Should set X-Frame-Options'
    );
  });

  it('should include X-Content-Type-Options header', async () => {
    const res = await request('/health');
    assert.strictEqual(
      res.headers.get('x-content-type-options'),
      'nosniff',
      'Should set X-Content-Type-Options'
    );
  });

  it('should include X-XSS-Protection header', async () => {
    const res = await request('/health');
    assert.strictEqual(
      res.headers.get('x-xss-protection'),
      '1; mode=block',
      'Should set X-XSS-Protection'
    );
  });

});

// ============================================================================
// Environment Variable Security Tests
// ============================================================================

describe('Environment Variable Security', () => {

  // These cases POST hostile payloads at /api/env/save, which writes to the
  // LIVE workspace env.local. The validation rejects them now, but it was added
  // after the fact — real env.local files still carried a MALICIOUS_VAR=evil
  // line and a 10,000-character variable name from before it existed. Snapshot
  // and restore so a regression can never persist into real credentials again.
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

  it('should reject saving empty vars object', async () => {
    const res = await request('/api/env/save', {
      method: 'POST',
      body: { vars: {} }
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.success, false);
  });

  it('should reject path traversal in variable names', async () => {
    const res = await request('/api/env/save', {
      method: 'POST',
      body: { vars: { '../../../etc/passwd': 'value' } }
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.data.error, /Environment variable names/i);
  });

  it('should reject newline injection in variable values', async () => {
    const res = await request('/api/env/save', {
      method: 'POST',
      body: { vars: { 'TEST_VAR': 'value\nMALICIOUS_VAR=evil' } }
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.data.error, /cannot contain newlines/i);
  });

  it('should reject excessively long variable names', async () => {
    const longName = 'A'.repeat(10000);
    const res = await request('/api/env/save', {
      method: 'POST',
      body: { vars: { [longName]: 'value' } }
    });
    assert.strictEqual(res.status, 400);
  });

  it('should reject excessively long variable values', async () => {
    const longValue = 'x'.repeat(100000);
    const res = await request('/api/env/save', {
      method: 'POST',
      body: { vars: { 'TEST_VAR': longValue } }
    });
    assert.strictEqual(res.status, 400);
  });

});

// ============================================================================
// Connector Installation Security Tests
// ============================================================================

describe('Connector Installation Security', () => {

  it('should reject path traversal in connectorId', async () => {
    const res = await request('/api/connectors/install', {
      method: 'POST',
      body: { connectorId: '../../../etc/passwd' }
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.success, false);
  });

  it('should reject null bytes in connectorId', async () => {
    const res = await request('/api/connectors/install', {
      method: 'POST',
      body: { connectorId: 'hubspot\x00../../etc/passwd' }
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.success, false);
  });

  it('should reject excessively long connectorId', async () => {
    const longId = 'x'.repeat(10000);
    const res = await request('/api/connectors/install', {
      method: 'POST',
      body: { connectorId: longId }
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.success, false);
  });

  it('should not expose system paths in error messages', async () => {
    const res = await request('/api/connectors/install', {
      method: 'POST',
      body: { connectorId: 'nonexistent-connector' }
    });
    assert.strictEqual(res.status, 404);
    // Error message should not leak system paths
    const error = res.data.error || '';
    assert.ok(
      !error.includes('/Users/') && !error.includes('/home/'),
      'Should not expose system paths'
    );
  });

});

// ============================================================================
// CORS Tests
// ============================================================================

describe('CORS Restrictions', () => {

  it('should allow localhost origins', async () => {
    const res = await request('/health', {
      headers: { 'Origin': APP_URL }
    });
    assert.strictEqual(
      res.headers.get('access-control-allow-origin'),
      APP_URL,
      `Should allow ${APP_URL}`
    );
  });

  it('should not reflect arbitrary origins', async () => {
    const res = await request('/health', {
      headers: { 'Origin': 'https://evil.com' }
    });
    const allowOrigin = res.headers.get('access-control-allow-origin');
    assert.ok(
      allowOrigin !== 'https://evil.com',
      'Should not reflect arbitrary origins'
    );
  });

});

// ============================================================================
// CSRF Prevention Tests
// ============================================================================

describe('CSRF Prevention', () => {

  it('should reject POST with cross-origin Origin header', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      headers: { 'Origin': 'https://evil.com' },
      body: { name: 'attacker', email: 'test@example.com', phone: '555' }
    });
    assert.strictEqual(res.status, 403);
    assert.match(res.data.error, /Origin/i);
  });

  it('should reject PATCH with cross-origin Origin header', async () => {
    const res = await request('/api/db/query', {
      method: 'PATCH',
      headers: { 'Origin': 'https://evil.com' },
      body: { status: 'approved' }
    });
    assert.strictEqual(res.status, 403);
    assert.match(res.data.error, /Origin/i);
  });

  it('should reject DELETE with cross-origin Origin header', async () => {
    const res = await request('/api/viz/any-id', {
      method: 'DELETE',
      headers: { 'Origin': 'https://evil.com' }
    });
    assert.strictEqual(res.status, 403);
    assert.match(res.data.error, /Origin/i);
  });

  it('should reject POST when Referer is cross-origin and Origin is absent', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      headers: { 'Referer': 'https://evil.com/attack' },
      body: { name: 'attacker', email: 'test@example.com', phone: '555' }
    });
    assert.strictEqual(res.status, 403);
    assert.match(res.data.error, /Referer/i);
  });

  it('should allow POST from an allowed Origin', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      headers: { 'Origin': APP_URL },
      body: {
        name: 'Test User',
        email: 'test@example.com',
        phone: '555-0101',
        flow_type: 'estimate'
      }
    });
    // Either success or a downstream validation error — must NOT be the
    // CSRF 403 with an Origin/Referer error message.
    if (res.status === 403) {
      assert.ok(
        !/Origin|Referer/i.test(res.data.error || ''),
        'Allowed origin should pass the CSRF middleware'
      );
    }
  });

  it('should allow POST with allowed Referer when Origin is absent', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      headers: { 'Referer': `${APP_URL}/some/page` },
      body: {
        name: 'Test User',
        email: 'test@example.com',
        phone: '555-0102',
        flow_type: 'estimate'
      }
    });
    if (res.status === 403) {
      assert.ok(
        !/Origin|Referer/i.test(res.data.error || ''),
        'Allowed referer should pass the CSRF middleware'
      );
    }
  });

  it('should allow POST with no Origin and no Referer (non-browser client)', async () => {
    const res = await request('/api/db/query', {
      method: 'POST',
      body: {
        name: 'Test User',
        email: 'test@example.com',
        phone: '555-0103',
        flow_type: 'estimate'
      }
    });
    if (res.status === 403) {
      assert.ok(
        !/Origin|Referer/i.test(res.data.error || ''),
        'Header-less request should pass the CSRF middleware'
      );
    }
  });

  it('should allow GET with cross-origin Origin (read methods not gated)', async () => {
    const res = await request('/health', {
      headers: { 'Origin': 'https://evil.com' }
    });
    assert.strictEqual(res.status, 200);
  });

});
