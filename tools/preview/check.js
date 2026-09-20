#!/usr/bin/env node
// Smoke-check a running preview without printing credentials, sessions, or business data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { url: { type: 'string' }, credentials: { type: 'string' } } });
if (!values.url || !values.credentials) throw new Error('Required: --url URL --credentials PATH');
const base = new URL(values.url);
if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('Remote checks require HTTPS');
const { password } = JSON.parse(readFileSync(values.credentials, 'utf8'));
const request = (path, options = {}) => fetch(new URL(path, base), { redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
for (const path of ['/api/viz', '/viz/visualizations.json', '/health']) {
  const res = await request(path, { headers: { accept: 'application/json' } });
  assert.equal(res.status, 401, `Unauthenticated ${path}`);
}
assert.equal((await request('/visualizations', { headers: { accept: 'text/html' } })).status, 200, 'Public app shell');
assert.equal((await request('/api/session')).status, 401, 'Unauthenticated session');
const login = await request('/api/session/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base.origin }, body: JSON.stringify({ password }) });
assert.equal(login.status, 200, 'Embedded login');
const setCookie = login.headers.get('set-cookie');
assert.ok(setCookie?.includes('HttpOnly') && setCookie.includes('SameSite=Strict'), 'Cookie flags');
if (base.protocol === 'https:') assert.ok(setCookie.includes('; Secure'), 'HTTPS requires Secure cookie');
const headers = { cookie: setCookie.split(';')[0] };
assert.equal((await request('/api/session', { headers })).status, 200, 'Authenticated session');
const registryResponse = await request('/api/viz', { headers });
assert.equal(registryResponse.status, 200);
const registry = await registryResponse.json();
const pending = ['/visualizations', ...registry.visualizations.map(v => `/viz/${v.filename}`), ...registry.projectsWithPresentation.map(p => `/viz/projects/${p}/index.html`)];
const checked = new Set();
const failures = [];
while (pending.length) {
  const path = pending.shift();
  if (checked.has(path)) continue;
  checked.add(path);
  const res = await request(path, { headers });
  if (res.status !== 200) { failures.push({ path, status: res.status }); continue; }
  if (res.headers.get('content-type')?.includes('text/html')) {
    const html = await res.text();
    for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      const reference = match[1];
      if (!reference || reference.startsWith('#') || /^(data:|mailto:|javascript:)/i.test(reference)) continue;
      const url = new URL(reference, new URL(path, base));
      if (url.origin === base.origin && /\.(js|css|html|svg|png|jpg|jpeg|webp|woff2?)(?:$|\?)/i.test(url.pathname)) pending.push(url.pathname);
    }
  }
}
for (const path of ['/api/workspace/switch', '/api/env/save', '/api/db/query']) {
  assert.equal((await request(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status, 403, path);
}
for (const path of ['/env.local', '/data/quickbooks/tokens.json', '/api/workspace/file?path=env.local']) {
  assert.ok([403, 404].includes((await request(path, { headers })).status), path);
}
const workspaces = await (await request('/api/workspaces', { headers })).json();
assert.equal(workspaces.workspaces.length, 1, 'One workspace only');
assert.equal((await request('/api/session/logout', { method: 'POST', headers: { ...headers, origin: base.origin } })).status, 200, 'Logout');
assert.equal((await request('/api/session', { headers })).status, 401, 'Session invalidated');
console.log(JSON.stringify({ url: base.origin, workspace: workspaces.workspaces[0].name, visualizations: registry.visualizations.length, presentations: registry.projectsWithPresentation.length, pathsChecked: checked.size, failures, authAndIsolationChecks: 'passed' }, null, 2));
if (failures.length) process.exitCode = 1;
