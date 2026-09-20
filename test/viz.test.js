/**
 * Visualization Tests for LocalBase Server
 *
 * Tests viz creation, listing, deletion, and pinning.
 * Run with: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startTestServer, stopTestServer, request } from './setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VIZ_DIR = join(ROOT, 'viz');
const VIZ_REGISTRY = join(VIZ_DIR, 'visualizations.json');

before(async () => {
  await startTestServer();
});

after(async () => {
  await stopTestServer();
});

// ============================================================================
// Visualization Registry
// ============================================================================

describe('Visualization Registry', () => {

  it('should have visualizations.json in viz folder', () => {
    assert.ok(existsSync(VIZ_REGISTRY), 'visualizations.json should exist');
  });

  it('visualizations.json should be valid JSON', () => {
    const content = readFileSync(VIZ_REGISTRY, 'utf-8');
    const data = JSON.parse(content);
    assert.ok(data.visualizations !== undefined, 'Should have visualizations array');
  });

  it('visualizations.json should have required fields', () => {
    const content = readFileSync(VIZ_REGISTRY, 'utf-8');
    const data = JSON.parse(content);
    assert.ok(Array.isArray(data.visualizations), 'visualizations should be an array');
    assert.ok(data.lastUpdated !== undefined, 'Should have lastUpdated');
  });

});

// ============================================================================
// Visualization API
// ============================================================================

describe('Visualization API', () => {

  it('GET /api/viz should return visualizations list', async () => {
    const res = await request('/api/viz');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.success === true || Array.isArray(res.data.visualizations));
  });

  it('GET /api/viz/:id should return 404 for non-existent viz', async () => {
    const res = await request('/api/viz/nonexistent-viz-id-12345');
    assert.strictEqual(res.status, 404);
  });

  it('DELETE /api/viz/:id should return 404 for non-existent viz', async () => {
    const res = await request('/api/viz/nonexistent-viz-id-12345', {
      method: 'DELETE'
    });
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/viz/:id/pin should handle non-existent viz', async () => {
    const res = await request('/api/viz/nonexistent-viz-id-12345/pin', {
      method: 'POST'
    });
    // May return 200 with error in body, or 404
    assert.ok(
      res.status === 200 || res.status === 404,
      `Expected 200 or 404, got ${res.status}`
    );
  });

});

// ============================================================================
// Visualization File Serving
// ============================================================================

describe('Visualization File Serving', () => {

  it('should serve viz files from /viz/ path', async () => {
    // Try to access viz-colors.js which should exist
    const res = await request('/viz/viz-colors.js');
    assert.strictEqual(res.status, 200, 'Should serve existing viz files');
  });

  it('should return 404 for non-existent viz files', async () => {
    const res = await request('/viz/nonexistent-file.html');
    assert.strictEqual(res.status, 404);
  });

});

// ============================================================================
// Current Visualization (Polling)
// ============================================================================

describe('Current Visualization', () => {

  const CURRENT_VIZ = join(VIZ_DIR, 'current.json');

  it('should be able to write and read current.json', () => {
    const testViz = {
      id: 'test-viz',
      title: 'Test Visualization',
      filename: 'test.html',
      url: '/viz/test.html',
      loadedAt: new Date().toISOString()
    };

    // Write
    writeFileSync(CURRENT_VIZ, JSON.stringify(testViz));
    assert.ok(existsSync(CURRENT_VIZ), 'current.json should be created');

    // Read
    const content = readFileSync(CURRENT_VIZ, 'utf-8');
    const data = JSON.parse(content);
    assert.strictEqual(data.id, 'test-viz');
    assert.strictEqual(data.title, 'Test Visualization');

    // Cleanup
    unlinkSync(CURRENT_VIZ);
  });

  it('current.json file operations work correctly', () => {
    const testViz = {
      id: 'api-test-viz',
      title: 'API Test',
      loadedAt: new Date().toISOString()
    };

    // Write and verify file operations work
    writeFileSync(CURRENT_VIZ, JSON.stringify(testViz));
    assert.ok(existsSync(CURRENT_VIZ), 'Should create current.json');

    const content = readFileSync(CURRENT_VIZ, 'utf-8');
    const data = JSON.parse(content);
    assert.strictEqual(data.id, 'api-test-viz');

    // Cleanup
    unlinkSync(CURRENT_VIZ);
    assert.ok(!existsSync(CURRENT_VIZ), 'Should delete current.json');
  });

});
