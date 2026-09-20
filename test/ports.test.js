/**
 * Port configuration tests.
 *
 * LocalBase deliberately does NOT use 3000/5173 — see tools/ports.js for why.
 * These tests pin that decision down so it cannot drift back by accident.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  resolvePort,
  resolvePorts,
  DEFAULT_API_PORT,
  DEFAULT_APP_PORT,
  MIN_PORT,
  MAX_PORT,
  API_PORT,
  APP_PORT,
  API_URL,
  APP_URL,
  ALLOWED_ORIGINS,
} from '../tools/ports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

describe('port defaults', () => {
  it('defaults to 9220 (API) and 9221 (app)', () => {
    assert.strictEqual(DEFAULT_API_PORT, 9220);
    assert.strictEqual(DEFAULT_APP_PORT, 9221);
    assert.strictEqual(API_PORT, 9220);
    assert.strictEqual(APP_PORT, 9221);
  });

  it('never defaults to the contested ecosystem ports', () => {
    for (const taken of [3000, 5173]) {
      assert.notStrictEqual(DEFAULT_API_PORT, taken);
      assert.notStrictEqual(DEFAULT_APP_PORT, taken);
    }
  });

  it('keeps the two ports distinct', () => {
    assert.notStrictEqual(DEFAULT_API_PORT, DEFAULT_APP_PORT);
  });

  it('avoids 9229, which is Node --inspect', () => {
    assert.notStrictEqual(DEFAULT_API_PORT, 9229);
    assert.notStrictEqual(DEFAULT_APP_PORT, 9229);
  });

  it('sits in the bindable-without-root, non-ephemeral range', () => {
    // < 1024 needs root; >= 49152 collides with OS-assigned outbound ports.
    for (const p of [DEFAULT_API_PORT, DEFAULT_APP_PORT]) {
      assert.ok(p >= MIN_PORT, `${p} is below ${MIN_PORT} — would need root`);
      assert.ok(p <= MAX_PORT, `${p} is in the ephemeral range`);
    }
  });
});

describe('derived URLs and origins', () => {
  it('derives URLs from the ports', () => {
    assert.strictEqual(API_URL, `http://localhost:${API_PORT}`);
    assert.strictEqual(APP_URL, `http://localhost:${APP_PORT}`);
  });

  it('allows both ports on both loopback spellings', () => {
    assert.deepStrictEqual([...ALLOWED_ORIGINS].sort(), [
      `http://127.0.0.1:${API_PORT}`,
      `http://127.0.0.1:${APP_PORT}`,
      `http://localhost:${API_PORT}`,
      `http://localhost:${APP_PORT}`,
    ].sort());
  });

  it('does not allow the old origins', () => {
    for (const stale of [
      'http://localhost:3000', 'http://localhost:5173',
      'http://127.0.0.1:3000', 'http://127.0.0.1:5173',
    ]) {
      assert.ok(!ALLOWED_ORIGINS.includes(stale), `${stale} must not be allowed`);
    }
  });

  it('allows no non-loopback origin', () => {
    for (const origin of ALLOWED_ORIGINS) {
      assert.match(origin, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
    }
  });
});

describe('resolvePort', () => {
  it('accepts a valid override', () => {
    assert.strictEqual(resolvePort('8080', 9220), 8080);
    assert.strictEqual(resolvePort(3000, 9220), 3000); // explicit opt-in still works
  });

  it('falls back when unset or blank', () => {
    assert.strictEqual(resolvePort(undefined, 9220), 9220);
    assert.strictEqual(resolvePort(null, 9220), 9220);
    assert.strictEqual(resolvePort('', 9220), 9220);
    assert.strictEqual(resolvePort('   ', 9220), 9220);
  });

  it('falls back on non-integers', () => {
    for (const bad of ['banana', '80.5', 'NaN', '9220abc', '0x2404', {}, []]) {
      assert.strictEqual(resolvePort(bad, 9220), 9220, `${JSON.stringify(bad)} should fall back`);
    }
  });

  it('rejects privileged ports — they need root', () => {
    for (const bad of [0, 1, 80, 443, 922, 1023]) {
      assert.strictEqual(resolvePort(String(bad), 9220), 9220, `${bad} should be refused`);
    }
  });

  it('rejects ephemeral and out-of-range ports', () => {
    for (const bad of [49152, 65535, 65536, 99999, -1]) {
      assert.strictEqual(resolvePort(String(bad), 9220), 9220, `${bad} should be refused`);
    }
  });

  it('accepts the range boundaries', () => {
    assert.strictEqual(resolvePort(String(MIN_PORT), 9220), MIN_PORT);
    assert.strictEqual(resolvePort(String(MAX_PORT), 9220), MAX_PORT);
  });
});

describe('resolvePorts', () => {
  it('honours both env vars independently', () => {
    const r = resolvePorts({ LOCALBASE_API_PORT: '8100', LOCALBASE_APP_PORT: '8101' });
    assert.strictEqual(r.apiPort, 8100);
    assert.strictEqual(r.appPort, 8101);
    assert.strictEqual(r.apiUrl, 'http://localhost:8100');
    assert.strictEqual(r.appUrl, 'http://localhost:8101');
  });

  it('overriding one leaves the other at its default', () => {
    const r = resolvePorts({ LOCALBASE_API_PORT: '8100' });
    assert.strictEqual(r.apiPort, 8100);
    assert.strictEqual(r.appPort, DEFAULT_APP_PORT);
  });

  it('rebuilds allowedOrigins around the overrides', () => {
    const r = resolvePorts({ LOCALBASE_API_PORT: '8100', LOCALBASE_APP_PORT: '8101' });
    assert.ok(r.allowedOrigins.includes('http://localhost:8101'));
    assert.ok(r.allowedOrigins.includes('http://127.0.0.1:8100'));
    assert.ok(!r.allowedOrigins.some((o) => o.endsWith(':9220')));
  });

  it('falls back to defaults on an empty env', () => {
    const r = resolvePorts({});
    assert.strictEqual(r.apiPort, DEFAULT_API_PORT);
    assert.strictEqual(r.appPort, DEFAULT_APP_PORT);
  });
});

describe('the module honours the real environment', () => {
  // The constants are frozen at import time, so this has to cross a process
  // boundary — a pure-function test alone would not prove the wiring works.
  const read = (env) => JSON.parse(execFileSync(
    process.execPath,
    ['-e', "import('./tools/ports.js').then(m=>console.log(JSON.stringify({api:m.API_PORT,app:m.APP_PORT,url:m.API_URL})))"],
    { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' },
  ));

  it('uses the defaults with no env set', () => {
    const r = read({ LOCALBASE_API_PORT: '', LOCALBASE_APP_PORT: '' });
    assert.strictEqual(r.api, 9220);
    assert.strictEqual(r.app, 9221);
  });

  it('picks up a real LOCALBASE_API_PORT', () => {
    const r = read({ LOCALBASE_API_PORT: '8100' });
    assert.strictEqual(r.api, 8100);
    assert.strictEqual(r.url, 'http://localhost:8100');
  });

  it('ignores a garbage LOCALBASE_API_PORT', () => {
    assert.strictEqual(read({ LOCALBASE_API_PORT: 'banana' }).api, 9220);
  });
});
