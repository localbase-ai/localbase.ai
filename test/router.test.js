/**
 * Router Tests for LocalBase URL Routing
 *
 * Tests URL parsing and building for client-side navigation.
 * Run with: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseUrl, buildUrl, VIEWS } from '../app/src/lib/router.js';

// ============================================================================
// URL Parsing
// ============================================================================

describe('parseUrl', () => {

  it('should return home view for root path', () => {
    const result = parseUrl('/');
    assert.strictEqual(result.view, 'home');
    assert.strictEqual(result.vizId, null);
    assert.strictEqual(result.projectId, null);
  });

  it('should parse /home path', () => {
    const result = parseUrl('/home');
    assert.strictEqual(result.view, 'home');
  });

  it('should parse /visualizations path', () => {
    const result = parseUrl('/visualizations');
    assert.strictEqual(result.view, 'visualizations');
    assert.strictEqual(result.vizId, null);
  });

  it('should parse /viz/:id path', () => {
    const result = parseUrl('/viz/deal-velocity');
    assert.strictEqual(result.view, 'visualizations');
    assert.strictEqual(result.vizId, 'deal-velocity');
  });

  it('should strip trailing .html from /viz/:id.html', () => {
    const result = parseUrl('/viz/deal-velocity.html');
    assert.strictEqual(result.view, 'visualizations');
    assert.strictEqual(result.vizId, 'deal-velocity');
  });

  it('should strip trailing .html with a query string', () => {
    const result = parseUrl('/viz/deal-velocity.html?t=123');
    assert.strictEqual(result.view, 'visualizations');
    assert.strictEqual(result.vizId, 'deal-velocity');
  });

  it('should only strip a trailing .html, not embedded ones', () => {
    const result = parseUrl('/viz/my.html.report');
    assert.strictEqual(result.vizId, 'my.html.report');
  });

  it('should strip trailing .html in /project/:projectId/:vizId.html', () => {
    const result = parseUrl('/project/pipeline-outlook/deal-velocity.html');
    assert.strictEqual(result.view, 'projects');
    assert.strictEqual(result.projectId, 'pipeline-outlook');
    assert.strictEqual(result.vizId, 'deal-velocity');
  });

  it('should parse /projects path', () => {
    const result = parseUrl('/projects');
    assert.strictEqual(result.view, 'projects');
    assert.strictEqual(result.projectId, null);
  });

  it('should parse /project/:id path', () => {
    const result = parseUrl('/project/pipeline-outlook');
    assert.strictEqual(result.view, 'projects');
    assert.strictEqual(result.projectId, 'pipeline-outlook');
    assert.strictEqual(result.vizId, null);
  });

  it('should parse /project/:projectId/:vizId path', () => {
    const result = parseUrl('/project/pipeline-outlook/business-account-quality');
    assert.strictEqual(result.view, 'projects');
    assert.strictEqual(result.projectId, 'pipeline-outlook');
    assert.strictEqual(result.vizId, 'business-account-quality');
  });

  it('should parse /settings path', () => {
    const result = parseUrl('/settings');
    assert.strictEqual(result.view, 'settings');
  });

  it('should handle legacy ?viz= query param', () => {
    const result = parseUrl('/?viz=deal-velocity');
    assert.strictEqual(result.view, 'visualizations');
    assert.strictEqual(result.vizId, 'deal-velocity');
  });

  it('should handle legacy ?project= query param', () => {
    const result = parseUrl('/?project=pipeline-outlook');
    assert.strictEqual(result.view, 'projects');
    assert.strictEqual(result.projectId, 'pipeline-outlook');
  });

  it('should return home for unknown paths', () => {
    const result = parseUrl('/unknown/path');
    assert.strictEqual(result.view, 'home');
  });

  it('should handle full URLs', () => {
    const result = parseUrl('http://localhost:9221/viz/my-chart');
    assert.strictEqual(result.view, 'visualizations');
    assert.strictEqual(result.vizId, 'my-chart');
  });

});

// ============================================================================
// URL Building
// ============================================================================

describe('buildUrl', () => {

  it('should build root path for home view', () => {
    const url = buildUrl('home');
    assert.strictEqual(url, '/');
  });

  it('should build /visualizations for visualizations view without vizId', () => {
    const url = buildUrl('visualizations');
    assert.strictEqual(url, '/visualizations');
  });

  it('should build /viz/:id for visualizations view with vizId', () => {
    const url = buildUrl('visualizations', 'deal-velocity');
    assert.strictEqual(url, '/viz/deal-velocity');
  });

  it('should build /projects for projects view without projectId', () => {
    const url = buildUrl('projects');
    assert.strictEqual(url, '/projects');
  });

  it('should build /project/:id for projects view with projectId', () => {
    const url = buildUrl('projects', null, 'pipeline-outlook');
    assert.strictEqual(url, '/project/pipeline-outlook');
  });

  it('should build /project/:projectId/:vizId for projects view with both ids', () => {
    const url = buildUrl('projects', 'business-account-quality', 'pipeline-outlook');
    assert.strictEqual(url, '/project/pipeline-outlook/business-account-quality');
  });

  it('should build /settings for settings view', () => {
    const url = buildUrl('settings');
    assert.strictEqual(url, '/settings');
  });

  it('should default to / for unknown views', () => {
    const url = buildUrl('unknown-view');
    assert.strictEqual(url, '/');
  });

});

// ============================================================================
// VIEWS constant
// ============================================================================

describe('VIEWS constant', () => {

  it('should export valid view names', () => {
    assert.ok(VIEWS.includes('home'));
    assert.ok(VIEWS.includes('visualizations'));
    assert.ok(VIEWS.includes('projects'));
    assert.ok(VIEWS.includes('settings'));
  });

});
