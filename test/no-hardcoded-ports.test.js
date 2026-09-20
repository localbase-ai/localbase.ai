/**
 * Regression guard: nothing may hardcode the old dev ports.
 *
 * The port migration (3000/5173 -> 9220/9221) touched a lot of files, and the
 * failure mode is silent — a stray `http://localhost:3000` still *looks* right
 * and only breaks when someone runs the app. tools/ports.js is the single
 * source of truth; this test fails if anything goes around it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Framework-owned trees. Instance-specific code (viz/, projects/, data/) is
// deliberately out of scope — it may legitimately talk to other services.
const SCAN_DIRS = ['tools', 'scripts', 'test', 'app/src'];
const SCAN_FILES = ['app/vite.config.js', 'package.json'];

const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.sh', '.json']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'coverage']);

// The only files allowed to name the old ports are the ones whose job is to
// talk about them: ports.js explains the decision in prose, and these two tests
// assert the old values are rejected. Everything else must go through ports.js.
const ALLOWLIST = new Set([
  'tools/ports.js',
  'test/ports.test.js',
  'test/no-hardcoded-ports.test.js',
]);

const STALE_PATTERNS = [
  { re: /localhost:3000/, label: 'localhost:3000' },
  { re: /localhost:5173/, label: 'localhost:5173' },
  { re: /127\.0\.0\.1:3000/, label: '127.0.0.1:3000' },
  { re: /127\.0\.0\.1:5173/, label: '127.0.0.1:5173' },
  { re: /\bPORT\s*=\s*3000\b/, label: 'PORT = 3000' },
  { re: /\bport:\s*5173\b/, label: 'port: 5173' },
  { re: /\bport:\s*3000\b/, label: 'port: 3000' },
];

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full);
    else if (SCAN_EXT.has(name.slice(name.lastIndexOf('.')))) yield full;
  }
}

function collectFiles() {
  const files = [];
  for (const d of SCAN_DIRS) {
    const full = join(ROOT, d);
    if (existsSync(full)) files.push(...walk(full));
  }
  for (const f of SCAN_FILES) {
    const full = join(ROOT, f);
    if (existsSync(full)) files.push(full);
  }
  return files;
}

describe('no hardcoded dev ports', () => {
  it('scans a non-trivial number of files (guard against a silently empty scan)', () => {
    assert.ok(collectFiles().length > 20, 'expected the scan to find real source files');
  });

  it('no source file hardcodes 3000 or 5173', () => {
    const offenders = [];
    for (const file of collectFiles()) {
      const rel = relative(ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      text.split('\n').forEach((line, i) => {
        for (const { re, label } of STALE_PATTERNS) {
          if (re.test(line)) offenders.push(`${rel}:${i + 1}  [${label}]  ${line.trim().slice(0, 90)}`);
        }
      });
    }
    assert.deepStrictEqual(
      offenders, [],
      `Hardcoded dev ports found — import from tools/ports.js instead:\n  ${offenders.join('\n  ')}\n`,
    );
  });
});

describe('the port config is actually wired up', () => {
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');

  it('app-server.js takes its port and CORS list from ports.js', () => {
    const src = read('tools/server/app-server.js');
    assert.match(src, /from '\.\.\/ports\.js'/, 'app-server must import ports.js');
    assert.match(src, /const PORT = API_PORT;/, 'PORT must come from API_PORT');
    assert.match(src, /const allowedOrigins = ALLOWED_ORIGINS;/, 'CORS list must come from ports.js');
  });

  it('vite.config.js takes its port and proxy target from ports.js', () => {
    const src = read('app/vite.config.js');
    assert.match(src, /from '\.\.\/tools\/ports\.js'/, 'vite config must import ports.js');
    assert.match(src, /port: APP_PORT/, 'dev server port must come from APP_PORT');
    assert.ok(!/target: 'http:\/\/localhost:\d+'/.test(src), 'proxy targets must not be literals');
    assert.match(src, /target: API_URL/, 'proxy must target API_URL');
  });

  it('every vite proxy route points at the API', () => {
    const src = read('app/vite.config.js');
    const routes = [...src.matchAll(/'(\/[a-z]+)':\s*\{/g)].map((m) => m[1]);
    assert.ok(routes.length >= 5, `expected the proxy routes, found ${routes.length}`);
    const targets = [...src.matchAll(/target:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    assert.strictEqual(targets.length, routes.length, 'every proxy route needs a target');
    assert.ok(targets.every((t) => t === 'API_URL'), `all targets must be API_URL, got ${targets}`);
  });

  it('the browser app uses same-origin paths, not an absolute API origin', () => {
    // API_BASE is '' by design — the app talks to the API through the Vite
    // proxy. An absolute origin re-introduces a port literal and breaks builds.
    const offenders = [];
    for (const file of walk(join(ROOT, 'app/src'))) {
      const text = readFileSync(file, 'utf8');
      if (/https?:\/\/localhost:\d+/.test(text)) offenders.push(relative(ROOT, file));
    }
    assert.deepStrictEqual(offenders, [], `app/src must not name a localhost origin: ${offenders}`);
  });
});
