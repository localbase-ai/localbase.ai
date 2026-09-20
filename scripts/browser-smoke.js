#!/usr/bin/env node
// Small end-to-end check for the authenticated browser preview.
// The preview is started against this repository, but uses an isolated
// temporary credential file and an ephemeral localhost port.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';

const repo = resolve(new URL('..', import.meta.url).pathname);
const password = randomBytes(32).toString('base64url');
const temp = mkdtempSync(join(tmpdir(), 'localbase-browser-smoke-'));
const credentials = join(temp, 'auth.json');
writeFileSync(credentials, JSON.stringify({ password }) + '\n', { mode: 0o600 });
chmodSync(credentials, 0o600);

const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePort(port)));
});

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [
  'tools/preview/server.js',
  '--workspace', repo,
  '--credentials', credentials,
  '--port', String(port),
], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });

const stop = () => {
  if (!server.killed) server.kill('SIGTERM');
  rmSync(temp, { recursive: true, force: true });
};
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });
process.on('SIGTERM', () => { stop(); process.exit(143); });

try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      // The preview process may need another moment to bind.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    if (attempt === 49) throw new Error(`Preview did not start.\n${serverOutput}`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/visualizations`, { waitUntil: 'networkidle' });
    await page.locator('#workspace-password').waitFor();
    assert.match(await page.locator('body').innerText(), /sign in to view this localbase workspace/i);

    await page.locator('#workspace-password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Sign out' }).waitFor();
    await page.getByText('Visualizations', { exact: true }).first().waitFor();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.locator('#workspace-password').waitFor();
    assert.match(await page.locator('body').innerText(), /sign in to view this localbase workspace/i);
  } finally {
    await browser.close();
  }
  console.log('✅ Browser smoke test passed: login, authenticated UI, and logout');
} finally {
  stop();
}
