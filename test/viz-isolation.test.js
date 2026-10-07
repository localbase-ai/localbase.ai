/**
 * Viz isolation: vizzes are served from the API origin, framed only by the
 * app, carry the key/scroll bridge, and can't make writes.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { request } from './setup.js';
import { API_PORT, APP_PORT } from '../tools/ports.js';

const NAME = `__isolation-test-${process.pid}`;
let vizDir;

before(async () => {
  const { data } = await request('/api/workspace');
  vizDir = join(data.path, 'viz');
  mkdirSync(vizDir, { recursive: true });
  writeFileSync(join(vizDir, `${NAME}.html`), '<!doctype html><html><head><title>t</title></head><body>hi</body></html>');
  writeFileSync(join(vizDir, `${NAME}-nohead.html`), '<p>no head</p>');
  writeFileSync(join(vizDir, `${NAME}.js`), 'window.x = 1;');
});

after(() => {
  for (const f of [`${NAME}.html`, `${NAME}-nohead.html`, `${NAME}.js`]) {
    try { unlinkSync(join(vizDir, f)); } catch { /* already gone */ }
  }
});

describe('Viz isolation', () => {
  it('injects the bridge into viz HTML, inside <head>', async () => {
    const res = await request(`/viz/${NAME}.html`);
    assert.strictEqual(res.status, 200);
    assert.match(res.data, /lb:key/);
    assert.ok(res.data.indexOf('lb:key') < res.data.indexOf('</head>'), 'bridge before </head>');
    assert.match(res.data, /<body>hi<\/body>/);
  });

  it('injects the bridge into HTML that has no <head>', async () => {
    const res = await request(`/viz/${NAME}-nohead.html`);
    assert.match(res.data, /lb:key/);
    assert.match(res.data, /<p>no head<\/p>/);
  });

  it('lets only the app frame a viz', async () => {
    const res = await request(`/viz/${NAME}.html`);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, new RegExp(`frame-ancestors .*http://localhost:${APP_PORT}`));
    assert.doesNotMatch(csp, /\*/);
    assert.strictEqual(res.headers.get('x-frame-options'), null);
  });

  it('serves non-HTML viz assets unchanged', async () => {
    const res = await request(`/viz/${NAME}.js`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data, 'window.x = 1;');
  });

  it('does not inject into a path outside viz/', async () => {
    const res = await request('/viz/..%2Fpackage.json');
    assert.ok(res.status === 403 || res.status === 404);
  });

  it('sandboxes every /api response, so none can run as the app', async () => {
    for (const path of ['/api/workspace', `/api/viz/${NAME}`, '/api/viz/does-not-exist']) {
      const res = await request(path);
      assert.match(res.headers.get('content-security-policy') || '', /^sandbox\b/, path);
      assert.doesNotMatch(res.headers.get('content-security-policy'), /allow-same-origin/, path);
    }
  });

  it('refuses writes from the viz origin', async () => {
    const res = await request('/api/workspace/switch', {
      method: 'POST',
      headers: { origin: `http://localhost:${API_PORT}` },
      body: { path: '/nonexistent' }
    });
    assert.strictEqual(res.status, 403);
  });

  it('refuses writes whose Referer is a viz', async () => {
    const res = await request('/api/workspace/switch', {
      method: 'POST',
      headers: { referer: `http://localhost:${API_PORT}/viz/${NAME}.html` },
      body: { path: '/nonexistent' }
    });
    assert.strictEqual(res.status, 403);
  });

  it('still accepts writes from the app origin', async () => {
    const res = await request('/api/workspace/switch', {
      method: 'POST',
      headers: { origin: `http://localhost:${APP_PORT}` },
      body: { path: '/nonexistent' }
    });
    assert.notStrictEqual(res.status, 403);
  });
});
