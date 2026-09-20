import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import inject from 'light-my-request';
import { createPreviewApp } from '../tools/preview/server.js';

test('preview authenticates every asset and pins reads to one workspace', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'localbase-preview-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const workspace = join(temp, 'demo');
  mkdirSync(join(workspace, 'app/dist'), { recursive: true });
  mkdirSync(join(workspace, 'viz/projects/example'), { recursive: true });
  mkdirSync(join(workspace, 'data'), { recursive: true });
  mkdirSync(join(workspace, 'connectors', 'demo-source'), { recursive: true });
  writeFileSync(join(workspace, 'app/dist/index.html'), '<html>APP SHELL</html>');
  writeFileSync(join(workspace, 'app/dist/app.js'), '/* frontend */');
  writeFileSync(join(workspace, 'viz/visualizations.json'), JSON.stringify({ visualizations: [{ id: 'chart', filename: 'chart.html' }] }));
  writeFileSync(join(workspace, 'viz/chart.html'), '<html>CHART</html>');
  writeFileSync(join(workspace, 'viz/chart-data.js'), 'const chartData = {};');
  writeFileSync(join(workspace, 'viz/projects/example/index.html'), '<html>PRESENTATION</html>');
  writeFileSync(join(workspace, 'data/tokens.json'), 'PRIVATE TOKEN FIXTURE');
  writeFileSync(join(workspace, 'connectors/demo-source/index.js'), 'export default {};');
  writeFileSync(join(workspace, 'connectors/demo-source/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  writeFileSync(join(workspace, 'data/demo.db'), 'SQLite fixture');
  writeFileSync(join(temp, 'other.json'), 'OTHER WORKSPACE FIXTURE');
  symlinkSync(join(temp, 'other.json'), join(workspace, 'viz/escape.json'));
  const password = ['fixture', 'password', 'for', 'preview', 'tests', 'only', '12345'].join('-');
  let time = 1000;
  const app = createPreviewApp({ workspace, password, now: () => time });
  const request = (url, options = {}) => inject(app, { url, ...options });
  let cookie;

  await t.test('unauthenticated and forged-session requests reveal no workspace content', async () => {
    for (const url of ['/api/workspace', '/api/viz', '/health', '/api/session', '/viz/chart.html', '/viz/chart-data.js', '/data/tokens.json']) {
      const response = await request(url, { headers: { accept: 'application/json', cookie: 'localbase_preview=forged' } });
      assert.equal(response.statusCode, 401, url);
      assert.ok(!response.payload.includes('CHART') && !response.payload.includes('PRIVATE TOKEN'));
    }
    const shell = await request('/visualizations', { headers: { accept: 'text/html' } });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.payload, /APP SHELL/);
    assert.equal((await request('/app.js')).statusCode, 200);
  });
  await t.test('cross-site login and wrong passwords fail; valid HTTPS login creates a secure cookie', async () => {
    const form = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'demo.test' }, payload: new URLSearchParams({ password }).toString() };
    assert.equal((await request('/login', { ...form, headers: { ...form.headers, origin: 'https://other.test' } })).statusCode, 403);
    assert.equal((await request('/login', { ...form, payload: 'password=wrong' })).statusCode, 401);
    const response = await request('/login', { ...form, headers: { ...form.headers, origin: 'https://demo.test', 'x-forwarded-proto': 'https' } });
    assert.equal(response.statusCode, 303);
    assert.match(response.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
    assert.match(response.headers['set-cookie'], /; Secure/);
    cookie = response.headers['set-cookie'].split(';')[0];
  });
  const authenticated = (url, options = {}) => request(url, { ...options, headers: { cookie, ...options.headers } });
  await t.test('JSON session login and logout manage the same protected session', async () => {
    const response = await request('/api/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://demo.test', host: 'demo.test', 'x-forwarded-proto': 'https' },
      payload: JSON.stringify({ password })
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
    const apiCookie = response.headers['set-cookie'].split(';')[0];
    assert.equal((await request('/api/session', { headers: { cookie: apiCookie } })).json().authenticated, true);
    const logout = await request('/api/session/logout', { method: 'POST', headers: { cookie: apiCookie, origin: 'https://demo.test', host: 'demo.test' } });
    assert.equal(logout.statusCode, 200);
    assert.equal((await request('/api/session', { headers: { cookie: apiCookie } })).statusCode, 401);
  });
  await t.test('app routes, visualization data and presentations load with authentication', async () => {
    for (const url of ['/visualizations', '/viz/chart', '/viz/chart.html', '/viz/chart-data.js', '/project/example', '/viz/projects/example/index.html', '/app.js']) {
      const response = await authenticated(url);
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    const registry = (await authenticated('/api/viz')).json();
    assert.deepEqual(registry.projectsWithPresentation, ['example']);
    assert.equal(registry.visualizations[0].id, 'chart');
    const workspaces = (await authenticated('/api/workspaces')).json();
    assert.equal(workspaces.workspaces.length, 1);
    assert.equal(workspaces.workspaces[0].name, 'demo');
    assert.ok(!JSON.stringify(workspaces).includes(temp));
    const connectors = (await authenticated('/api/connectors')).json();
    assert.deepEqual(connectors.connectors.map(connector => connector.id), ['demo-source']);
    assert.ok(!JSON.stringify(connectors).includes(temp));
    const logo = await authenticated('/api/connectors/demo-source/logo');
    assert.equal(logo.statusCode, 200);
    assert.match(logo.headers['content-type'], /image\/svg\+xml/);
    assert.equal((await authenticated('/api/connectors/../demo-source/logo')).statusCode, 403);
    const dataSources = (await authenticated('/api/datasources')).json();
    assert.ok(dataSources.sources['demo.db']);
    assert.ok(!JSON.stringify(dataSources).includes(temp));
  });
  await t.test('all operator mutations and unapproved data paths remain inaccessible after login', async () => {
    for (const url of ['/api/workspace/switch', '/api/env/save', '/api/connectors/install', '/api/datasources/example/sync', '/api/db/query']) {
      assert.equal((await authenticated(url, { method: 'POST', payload: '{}' })).statusCode, 403, url);
    }
    assert.equal((await authenticated('/api/workspace', { method: 'DELETE' })).statusCode, 403);
    for (const url of ['/env.local', '/data/tokens.json', '/projects/private.json', '/api/workspace/file?path=env.local', '/viz/escape.json', '/viz/%2e%2e/data/tokens.json', '/viz/.hidden.json']) {
      const result = await authenticated(url);
      assert.ok([403, 404].includes(result.statusCode), `${url}: ${result.statusCode}`);
      assert.ok(!result.payload.includes('PRIVATE TOKEN') && !result.payload.includes('OTHER WORKSPACE'));
    }
  });
  await t.test('sessions expire and fail after server restart', async () => {
    const restarted = createPreviewApp({ workspace, password });
    assert.equal((await inject(restarted, { url: '/api/viz', headers: { cookie } })).statusCode, 401);
    time += 8 * 60 * 60_000 + 1;
    assert.equal((await authenticated('/api/viz')).statusCode, 401);
  });
  await t.test('repeated invalid logins are limited', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await request('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'password=wrong' })).statusCode, 401);
    assert.equal((await request('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'password=wrong' })).statusCode, 429);
  });
});
