/**
 * One-time Google authorization, shared by every Google connector.
 *
 * A connector's authorize.js is a few lines: it passes its auth bundle (from
 * `googleAuth()` in google-oauth.js), a label, and an optional `afterConnect`
 * that lists what the new token can see.
 *
 *   node connectors/<name>/authorize.js            opens the browser
 *   node connectors/<name>/authorize.js --manual   paste the redirect URL instead
 *
 * Google allows any loopback port for a Desktop-app OAuth client, so there is
 * nothing to pre-register: the port is chosen here (GOOGLE_CALLBACK_PORT) and
 * passed as the redirect URI.
 */
import { createServer } from 'http';
import { createInterface } from 'readline/promises';
import { spawn } from 'child_process';
import { createPkcePair, createState } from './google-oauth.js';

const PORT = Number(process.env.GOOGLE_CALLBACK_PORT ?? 3458);
const REDIRECT_URI = `http://localhost:${PORT}`;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const incoming = new URL(req.url, `http://${req.headers.host}`);
      const code = incoming.searchParams.get('code');
      const state = incoming.searchParams.get('state');
      const error = incoming.searchParams.get('error');

      // `close` only for the request that settles the flow. Anything on this
      // machine, or any web page via an <img>, can hit the port; a request
      // without our state gets a 400 and the server keeps waiting for Google.
      const reply = (ok, message, close) => {
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8">
          <body style="font-family:-apple-system,sans-serif;background:#0a0e1a;color:#e0e6ed;
                       display:grid;place-items:center;height:100vh;margin:0">
          <div style="text-align:center">
            <h1 style="color:${ok ? '#4ade80' : '#ef4444'};font-size:20px">${ok ? 'Connected' : 'Authorization failed'}</h1>
            <p style="color:#8b92a7;font-size:14px">${escapeHtml(message)}</p>
          </div></body>`);
        if (close) server.close();
      };

      if (state !== expectedState) { reply(false, 'This request did not come from this sign-in. Ignoring it.', false); return; }
      if (error) { reply(false, error, true); reject(new Error(`Google returned: ${error}`)); return; }
      if (!code) { reply(false, 'No authorization code in the redirect.', true); reject(new Error('No authorization code')); return; }
      reply(true, 'You can close this tab and return to the terminal.', true);
      resolve(code);
    });

    server.on('error', (err) => reject(
      err.code === 'EADDRINUSE'
        ? new Error(`Port ${PORT} is in use. Set GOOGLE_CALLBACK_PORT to a free port and retry.`)
        : err
    ));
    server.listen(PORT, '127.0.0.1');
  });
}

export async function runAuthorize({ auth, label, afterConnect = null }) {
  const manual = process.argv.includes('--manual');
  const creds = auth.loadClientCredentials();

  if (auth.readTokens()) {
    console.log('⚠️  Already connected. Re-authorizing will replace the stored tokens.\n');
  }

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const url = auth.buildAuthorizeUrl({
    clientId: creds.clientId,
    redirectUri: REDIRECT_URI,
    state,
    codeChallenge: challenge,
  });

  console.log(`🔐 Authorize ${label} access:\n`);
  console.log(`   ${url}\n`);
  console.log(`   scope: ${auth.SCOPES.join(' ')}`);
  if (creds.projectId) console.log(`   project: ${creds.projectId}`);

  let code;
  if (manual) {
    console.log('\n   Approve in the browser, then paste the full URL you land on.\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const pasted = await rl.question('   Redirect URL: ');
    rl.close();
    const parsed = new URL(pasted.trim());
    if (parsed.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
    code = parsed.searchParams.get('code');
    if (!code) throw new Error('No ?code= in that URL');
  } else {
    console.log('\n   (opening in your browser — approve access there)\n');
    console.log(`   listening on ${REDIRECT_URI}\n`);
    const waiting = waitForCallback(state);
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    code = await waiting;
  }

  console.log('   Exchanging code for tokens…');
  const tokens = await auth.exchangeCode({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    code,
    redirectUri: REDIRECT_URI,
    codeVerifier: verifier,
  });

  const who = await auth.whoami(tokens.accessToken);
  console.log(`\n✅ Connected as ${who?.email ?? 'unknown'}. Token saved to ${auth.TOKEN_PATH}`);
  if (afterConnect) await afterConnect();
}

/** Standard entry point: run, print a clean error, exit non-zero. */
export function main(opts) {
  runAuthorize(opts).catch((err) => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  });
}
