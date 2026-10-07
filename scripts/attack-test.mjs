#!/usr/bin/env node
// Live attack suite: boots the real API server and the Vite dev server on
// spare ports against a throwaway workspace seeded with fake secrets, then
// attacks them the way a malicious website or a malicious viz would.
//
// The unit tests call the Express app in-process, so they never see the dev
// server's proxy or a real browser — which is how a viz-isolation bypass
// through the proxy once got past them. This suite covers exactly that layer.
//
//   node scripts/attack-test.mjs          (also: npm run test:attacks)
//
// Exit 0 = every attack failed and every legitimate request still worked.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import { chromium } from '@playwright/test';

const repo = resolve(new URL('..', import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), 'localbase-attack-'));
const ws = join(temp, 'workspace');
const CANARY = 'planted-canary-must-never-be-served';
const VIZ_MARKER = 'attack-suite-viz-marker';

// ── Throwaway workspace ──────────────────────────────────────────────────────
const put = (rel, content) => {
  const file = join(ws, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
};
put('viz/visualizations.json', JSON.stringify({
  visualizations: [{ id: 'probe', filename: 'probe.html', title: 'Probe', type: 'dashboard', library: 'html', url: '/viz/probe.html', size: 0, date: new Date().toISOString(), createdAt: new Date().toISOString(), views: 0, lastViewed: null }],
  lastUpdated: new Date().toISOString(), totalVisualizations: 1, totalViews: 0, version: '1.0',
}, null, 2));
put('viz/probe.html', `<!doctype html><html><head><title>probe</title></head><body><h1>${VIZ_MARKER}</h1><div style="height:5000px"></div></body></html>`);
put('data/app.db', 'SQLITE-BYTES-OK');
put('data/daily.json', '{"rows":1}');
const SECRET_FILES = [
  'env.local', '.env', 'data/quickbooks/tokens.json', 'data/jobber/token.json',
  'connectors/gmail/gmail_token.json', 'data/x/foo.token.json', 'connectors/x/credentials.json',
  'connectors/gmail/gmail_credentials.json', 'connectors/google/oauth-credentials.json',
  'connectors/google/client_secret_123.json', 'data/x/service-account.json',
  'data/x/refresh_token.txt', 'data/preview/auth.json', 'data/preview/other.txt',
  'projects/x/auth.json', 'data/x/server.pem', 'data/x/cert.p12',
];
for (const f of SECRET_FILES) put(f, `${CANARY} ${f}`);
put('.git/config', `${CANARY} git`);
const envBefore = readFileSync(join(ws, 'env.local'), 'utf8');

// ── Servers ──────────────────────────────────────────────────────────────────
// tools/ports.js only accepts 1024–49151 and silently falls back to the
// default ports otherwise — which would aim this suite at a real server.
const freePort = async () => {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const free = await new Promise((ok) => {
      const probe = createServer();
      probe.once('error', () => ok(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => ok(true)));
    });
    if (free) return port;
  }
};
const API = await freePort();
const APP = await freePort();
const env = { ...process.env, HOME: join(temp, 'home'), LOCALBASE_ROOT: join(temp, 'none'), LOCALBASE_API_PORT: String(API), LOCALBASE_APP_PORT: String(APP) };
mkdirSync(env.HOME, { recursive: true });
const logs = [];
const start = (cmd, args, cwd) => {
  const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => logs.push(String(d)));
  p.stderr.on('data', d => logs.push(String(d)));
  return p;
};
const api = start(process.execPath, [join(repo, 'tools/server/app-server.js')], ws);
const vite = start(process.execPath, [join(repo, 'app/node_modules/vite/bin/vite.js'), '--port', String(APP), '--strictPort'], join(repo, 'app'));
let browser;
const stop = () => { for (const p of [api, vite]) p.kill('SIGTERM'); browser?.close().catch(() => {}); if (process.env.KEEP_ATTACK_WS) console.log('kept', ws); else rmSync(temp, { recursive: true, force: true }); };

// Raw HTTP so paths and Host headers go out exactly as written.
const raw = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((ok) => {
  // The API binds 127.0.0.1; Vite binds "localhost", which may be ::1 only.
  const req = http.request({ host: port === API ? '127.0.0.1' : 'localhost', port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
    let data = ''; res.on('data', c => { data += c; }); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: data }));
  });
  req.on('error', e => ok({ status: 0, headers: {}, body: String(e) }));
  if (body) req.write(body);
  req.end();
});
const waitFor = async (port, path) => {
  for (let i = 0; i < 100; i++) { if ((await raw(port, path)).status === 200) return; await new Promise(r => setTimeout(r, 150)); }
  throw new Error(`server on :${port} never came up\n${logs.join('').slice(-2000)}`);
};

// ── Checks ───────────────────────────────────────────────────────────────────
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });
const leaks = (r) => r.body.includes(CANARY);

try {
  await waitFor(API, '/health');
  await waitFor(APP, '/');
  // Never attack anything but the throwaway workspace.
  const served = JSON.parse((await raw(API, '/api/workspace')).body || '{}').path || '';
  if (!served.endsWith('/localbase-attack-' + temp.split('localbase-attack-')[1] + '/workspace')) {
    throw new Error(`refusing to attack: API on :${API} serves ${served}, not the throwaway workspace`);
  }
  const appShell = (await raw(APP, '/')).body;
  const isAppShell = (r) => r.status === 200 && r.body === appShell;

  // 1. DNS rebinding: a hostile name pointed at 127.0.0.1.
  for (const host of ['evil.example', `evil.example:${API}`, 'localhost.evil.example', '127.0.0.1.evil.example', '0.0.0.0']) {
    const r = await raw(API, '/api/workspaces', { headers: { host } });
    check(`rebinding Host ${host} → API refused`, r.status === 403, r.status);
  }
  const rv = await raw(APP, '/', { headers: { host: 'evil.example' } });
  check('rebinding Host → dev server refused', rv.status === 403, rv.status);

  // 2. Secret files, by every route and spelling, on both ports.
  const spellings = (f) => [f, f.toUpperCase(), f.replace(/([^/]+)$/, (m) => encodeURIComponent(m).replace(/t/, '%74')), f.replace('/', '//'), f.replace('/', '/./')];
  for (const f of SECRET_FILES) {
    for (const port of [API, APP]) {
      for (const p of spellings(f)) {
        const r = await raw(port, '/' + p);
        check(`GET :${port === API ? 'api' : 'app'} /${p}`, !leaks(r), r.status);
      }
      const r = await raw(port, `/api/workspace/file?path=${encodeURIComponent(f)}`);
      check(`workspace/file ${f} via ${port === API ? 'api' : 'app'}`, !leaks(r), r.status);
    }
  }
  for (const p of ['/data/../env.local', '/data/%2e%2e/env.local', '/viz/..%2Fenv.local', '/projects/../env.local', '/.git/config']) {
    for (const port of [API, APP]) {
      const r = await raw(port, p);
      check(`traversal ${p} via ${port === API ? 'api' : 'app'}`, !leaks(r), r.status);
    }
  }

  // 3. Nothing a viz controls may be served on the app's own origin.
  for (const p of ['/viz/probe.html', '/viz/probe.htm', '/data/app.db', '/projects/x/auth.json', `/@fs${ws}/viz/probe.html`]) {
    const r = await raw(APP, p);
    check(`app origin does not serve ${p}`, !r.body.includes(VIZ_MARKER) && !leaks(r) && !r.body.includes('SQLITE-BYTES'), r.status);
  }
  for (const p of ['/api/viz/probe', '/api/workspace', '/api/connectors']) {
    const r = await raw(APP, p);
    check(`app origin ${p} is sandboxed`, /^sandbox\b/.test(r.headers['content-security-policy'] || '') && !/allow-same-origin/.test(r.headers['content-security-policy'] || ''), r.headers['content-security-policy']);
  }

  // 4. Writes: only the app's origin may change anything.
  const write = (origin, extra = {}) => raw(API, '/api/env/save', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...extra }, body: JSON.stringify({ vars: { QUICKBOOKS_ENABLE_WRITES: 'true' } }) });
  for (const origin of [`http://localhost:${API}`, `http://127.0.0.1:${API}`, 'https://evil.example', 'null']) {
    const r = await write(origin);
    check(`write with Origin ${origin} refused`, r.status === 403, r.status);
  }
  const ref = await write(null, { referer: `http://localhost:${API}/viz/probe.html` });
  check('write with viz Referer refused', ref.status === 403, ref.status);

  // 5. Framing: only the app may frame a viz; nobody may frame the app.
  const vizHeaders = (await raw(API, '/viz/probe.html')).headers;
  check('viz frame-ancestors limited to the app', /frame-ancestors 'self' http:\/\/localhost:\d+/.test(vizHeaders['content-security-policy'] || '') && !/\*/.test(vizHeaders['content-security-policy'] || ''), vizHeaders['content-security-policy']);
  const appHeaders = (await raw(APP, '/')).headers;
  check('app refuses foreign framing', appHeaders['x-frame-options'] === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(appHeaders['content-security-policy'] || ''), appHeaders['x-frame-options']);

  // 6. Legitimate traffic still works.
  check('viz served on its own origin', (await raw(API, '/viz/probe.html')).body.includes(VIZ_MARKER));
  check('viz data still loads', (await raw(API, '/data/app.db')).body === 'SQLITE-BYTES-OK');
  check('viz JSON data still loads', (await raw(API, '/data/daily.json')).status === 200);

  // 7. In a real browser, from inside a viz.
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${APP}/viz/probe`);
  const frameEl = await page.waitForSelector('iframe', { timeout: 15000 });
  const vizFrame = await frameEl.contentFrame();
  await vizFrame.waitForSelector('h1', { timeout: 15000 });
  check('browser: viz renders inside the app', (await vizFrame.textContent('h1')) === VIZ_MARKER);
  check('browser: viz runs on the API origin', new URL(vizFrame.url()).port === String(API), vizFrame.url());
  check('browser: iframe is sandboxed without top-navigation', !/allow-top-navigation|allow-popups-to-escape-sandbox/.test(await frameEl.getAttribute('sandbox') || 'none') && !!(await frameEl.getAttribute('sandbox')));

  const fromViz = await vizFrame.evaluate(async ({ api, app }) => {
    const out = {};
    try { out.parentDom = !!window.parent.document.body; } catch { out.parentDom = false; }
    const post = async (url) => { try { return (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vars: { QUICKBOOKS_ENABLE_WRITES: 'true' } }) })).status; } catch { return 'blocked'; } };
    out.writeApi = await post(`http://localhost:${api}/api/env/save`);
    out.writeApp = await post(`http://localhost:${app}/api/env/save`);
    out.writeNoRef = await (async () => { try { return (await fetch('/api/env/save', { method: 'POST', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: '{"vars":{"X":"1"}}' })).status; } catch { return 'blocked'; } })();
    out.readToken = await (async () => { try { return (await (await fetch('/data/quickbooks/tokens.json')).text()); } catch { return ''; } })();
    out.dataOk = await (async () => { try { return (await (await fetch('/data/app.db')).text()); } catch { return ''; } })();
    return out;
  }, { api: API, app: APP });
  check('browser: viz cannot reach the app page', fromViz.parentDom === false);
  check('browser: viz cannot write via the API', fromViz.writeApi === 403 || fromViz.writeApi === 'blocked', fromViz.writeApi);
  check('browser: viz cannot write via the app proxy', fromViz.writeApp === 403 || fromViz.writeApp === 'blocked', fromViz.writeApp);
  check('browser: viz cannot write with no Referer', fromViz.writeNoRef === 403 || fromViz.writeNoRef === 'blocked', fromViz.writeNoRef);
  check('browser: viz cannot read tokens', !fromViz.readToken.includes(CANARY));
  check('browser: viz can read its data', fromViz.dataOk === 'SQLITE-BYTES-OK');

  // The bypass that slipped through once: the viz reopens itself on the app origin.
  for (const target of [`http://localhost:${APP}/viz/probe.html`, `http://localhost:${APP}/api/viz/probe`]) {
    await vizFrame.evaluate((u) => { location.href = u; }, target).catch(() => {});
    await page.waitForTimeout(1500);
    const landed = page.frames().find(f => f !== page.mainFrame());
    // Escaping means the viz's own content now runs on the app's origin. If
    // the frame instead holds the app shell (trusted code), the attacker's
    // script was unloaded by its own navigation and gained nothing. (Don't
    // run test code in the landed frame and call that an escape: Playwright
    // can execute anywhere, an attacker can't.)
    let escaped = false;
    if (landed) {
      const onAppOrigin = new URL(landed.url()).port === String(APP);
      const vizContent = await landed.evaluate(() => document.documentElement.outerHTML.includes('attack-suite-viz-marker')).catch(() => false);
      escaped = onAppOrigin && vizContent;
    }
    check(`browser: viz reopened at ${new URL(target).pathname} gains nothing`, !escaped);
    await page.goto(`http://localhost:${APP}/viz/probe`);
    await page.waitForSelector('iframe');
  }

  // Bridged keys: a viz may scroll itself, not drive the app.
  const before = page.url();
  const frame2 = await (await page.waitForSelector('iframe')).contentFrame();
  await frame2.waitForSelector('h1');
  await frame2.evaluate(() => { for (const key of ['h', 'l', 'R', 'f']) window.top.postMessage({ type: 'lb:key', key, shiftKey: key === 'R' }, '*'); });
  await page.waitForTimeout(800);
  check('browser: viz cannot drive app history or reload', page.url() === before, page.url());
  await frame2.evaluate(() => window.top.postMessage({ type: 'lb:key', key: 'G' }, '*'));
  await page.waitForTimeout(1200);
  check('browser: bridged scroll still works', (await frame2.evaluate(() => (document.scrollingElement || document.documentElement).scrollTop)) > 0);

  check('env.local unchanged after every attack', readFileSync(join(ws, 'env.local'), 'utf8') === envBefore);
} catch (error) {
  check('suite ran to completion', false, error.message);
} finally {
  stop();
}

// ── Report ───────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.pass);
for (const r of failed) console.log(`  ✗ ${r.name}${r.detail !== '' ? `  (${r.detail})` : ''}`);
console.log(failed.length
  ? `\n❌ Attack suite: ${failed.length} of ${results.length} checks failed`
  : `✅ Attack suite: all ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
