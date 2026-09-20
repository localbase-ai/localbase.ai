#!/usr/bin/env node
// A temporary, authenticated viewer. Never mounts the operator API or workspace root.
import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, sep, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const assetTypes = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf']);
const digest = value => createHash('sha256').update(String(value)).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Resolve symlinks as well as '..': Express's static root alone is not a symlink boundary.
function containedFile(root, name) {
  const candidate = realpathSync(join(root, name));
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(candidate) === root) throw new Error('Outside root');
  if (rel.split(sep).some(part => part.startsWith('.')) || !statSync(candidate).isFile()) throw new Error('Not a public file');
  return candidate;
}

export function createPreviewApp({ workspace, password, now = Date.now }) {
  if (typeof password !== 'string' || password.length < 32) throw new Error('A password of at least 32 characters is required');
  const root = realpathSync(workspace);
  const appRoot = realpathSync(join(root, 'app/dist'));
  const vizRoot = realpathSync(join(root, 'viz'));
  // Fail before opening a listener if the frontend or registry is missing.
  containedFile(appRoot, 'index.html');
  containedFile(vizRoot, 'visualizations.json');
  const name = basename(root);
  const virtualPath = `/workspace/${name}`;
  const listConnectors = () => {
    const connectors = [];
    const connectorsRoot = join(root, 'connectors');
    if (!existsSync(connectorsRoot)) return connectors;
    for (const entry of readdirSync(connectorsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'example') continue;
      const id = entry.name;
      const connectorRoot = join(connectorsRoot, id);
      let status = 'missing-index';
      try { if (containedFile(connectorsRoot, `${id}/index.js`)) status = 'active'; } catch { /* metadata only */ }
      connectors.push({ id, name: id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '), status, lastSync: 'Available' });
    }
    return connectors;
  };
  const listDataSources = () => {
    const sources = {};
    const dataRoot = join(root, 'data');
    const visit = (dir, relativeDir = '') => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'preview') continue;
        const absolute = join(dir, entry.name);
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(absolute, relativePath);
        else if (entry.name.endsWith('.db')) {
          const stat = statSync(absolute);
          sources[relativePath] = { name: entry.name.replace(/\.db$/, ''), path: `${virtualPath}/data/${relativePath}`, size: stat.size, modified: stat.mtime.toISOString() };
        }
      }
    };
    visit(dataRoot);
    return sources;
  };
  const sessions = new Map();
  const failures = new Map();
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
    // Reject encoded traversal and dotfiles before any file lookup.
    let path;
    try { path = decodeURIComponent(req.path); } catch { return res.sendStatus(400); }
    if (path.includes('\\') || path.includes('\0') || path.split('/').some(p => p.startsWith('.'))) return res.sendStatus(403);
    next();
  });
  const loginPage = error => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>LocalBase sign in</title><style>body{font:16px system-ui;background:#101820;color:#eef3f7;display:grid;place-items:center;min-height:95vh}main{max-width:340px;padding:28px}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:12px;font:inherit;border-radius:6px}button{background:#b9f18a;border:0;cursor:pointer}p{line-height:1.5;color:#bbc7d0}</style></head><body><main><h1>${escapeHtml(name)}</h1><p>Sign in to view this LocalBase workspace.</p><form method="post" action="/login"><label for="password">Workspace password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>Sign in</button></form>${error ? '<p>Sign-in failed. Check your password or try again later.</p>' : ''}</main></body></html>`;
  const sessionToken = req => (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('localbase_preview='))?.slice('localbase_preview='.length) || '';
  const hasValidSession = req => {
    const token = sessionToken(req);
    const key = digest(token).toString('hex');
    if ((sessions.get(key) || 0) <= now()) {
      sessions.delete(key);
      return false;
    }
    return true;
  };
  const originIsSameSite = req => {
    if (!req.headers.origin) return true;
    try { return new URL(req.headers.origin).host === req.headers.host; }
    catch { return false; }
  };
  const signIn = (req, suppliedPassword) => {
    if (!originIsSameSite(req)) return { status: 403, error: 'Invalid request origin' };
    const time = now();
    for (const [key, value] of failures) if (value.until <= time) failures.delete(key);
    for (const [key, expiry] of sessions) if (expiry <= time) sessions.delete(key);
    const client = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
    const attempt = failures.get(client) || { count: 0, until: time + 15 * 60_000 };
    if (attempt.count >= 10 || failures.size >= 10000 || sessions.size >= 1000) return { status: 429, error: 'Too many attempts' };
    if (!equal(suppliedPassword || '', password)) {
      attempt.count++;
      failures.set(client, attempt);
      return { status: 401, error: 'Invalid password' };
    }
    failures.delete(client);
    const token = randomBytes(32).toString('hex');
    sessions.set(digest(token).toString('hex'), time + 8 * 60 * 60_000);
    return { status: 200, token };
  };
  const setSessionCookie = (req, res, token, maxAge = 28800) => {
    const secure = req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `localbase_preview=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  };
  app.get('/login', (req, res) => res.type('html').send(loginPage(false)));
  app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const result = signIn(req, req.body?.password);
    if (result.status !== 200) return res.status(result.status).type('html').send(loginPage(true));
    setSessionCookie(req, res, result.token);
    res.redirect(303, '/visualizations');
  });
  app.get('/api/session', (req, res) => {
    if (!hasValidSession(req)) return res.status(401).json({ preview: true, authenticated: false, workspace: name });
    res.json({ preview: true, authenticated: true, workspace: name });
  });
  app.post('/api/session/login', express.json({ limit: '2kb' }), (req, res) => {
    const result = signIn(req, req.body?.password);
    if (result.status !== 200) return res.status(result.status).json({ success: false, error: result.error });
    setSessionCookie(req, res, result.token);
    res.json({ success: true, authenticated: true, preview: true, workspace: name });
  });
  app.post('/api/session/logout', (req, res) => {
    if (!originIsSameSite(req)) return res.sendStatus(403);
    const token = sessionToken(req);
    sessions.delete(digest(token).toString('hex'));
    setSessionCookie(req, res, '', 0);
    res.json({ success: true });
  });
  app.use((req, res, next) => {
    if (!hasValidSession(req)) {
      const path = req.path;
      const isPublicAppRoute = path === '/' || path === '/home' || path === '/visualizations' || path === '/projects' || path === '/settings' || /^\/viz\/[^/.]+$/.test(path) || /^\/project\/[^/.]+(?:\/[^/.]+)?$/.test(path);
      const isPublicAppAsset = !path.startsWith('/api/') && !path.startsWith('/viz/') && !path.startsWith('/data/') && !path.startsWith('/projects/') && assetTypes.has(extname(path).toLowerCase());
      if (req.method === 'GET' && (isPublicAppRoute || isPublicAppAsset)) return next();
      if (req.method === 'GET' && req.accepts('html') && !path.startsWith('/api/')) return res.redirect(303, '/login');
      return res.status(401).json({ success: false, error: 'Sign in required' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(403).json({ success: false, error: 'Preview is read-only. Use the local operator app or terminal.' });
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok', workspace: name, mode: 'preview' }));
  app.get('/api/workspace', (req, res) => res.json({ success: true, workspace: name, path: virtualPath }));
  app.get('/api/workspaces', (req, res) => res.json({ success: true, workspaces: [{ name, path: virtualPath, active: true }], current: virtualPath }));
  app.get('/api/viz', (req, res, next) => {
    try {
      const registry = JSON.parse(readFileSync(containedFile(vizRoot, 'visualizations.json'), 'utf8'));
      const projectsWithPresentation = [];
      const presentationCounts = {};
      const projectRoot = join(vizRoot, 'projects');
      if (existsSync(projectRoot)) for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
          containedFile(vizRoot, `projects/${entry.name}/index.html`);
          projectsWithPresentation.push(entry.name);
          presentationCounts[entry.name] = readdirSync(join(projectRoot, entry.name)).filter(f => f.endsWith('.html') && f !== 'index.html').length;
        } catch { /* Not a presentation. */ }
      }
      res.json({ success: true, visualizations: registry.visualizations || [], projectsWithPresentation, presentationCounts, agentProjects: [], total: registry.visualizations?.length || 0 });
    } catch (error) { next(error); }
  });
  // Supply harmless metadata expected by the existing app chrome; no operator API is loaded.
  app.get('/api/tools', (req, res) => res.json({ success: true, tools: [] }));
  app.get('/api/connectors', (req, res) => {
    const connectors = listConnectors();
    res.json({ success: true, connectors, total: connectors.length });
  });
  app.get('/api/connectors/:id/logo', (req, res) => {
    // Logos are presentation assets only. Keep the route constrained to the
    // connector directory and the two formats the UI supports.
    if (!/^[a-zA-Z0-9_-]+$/.test(req.params.id)) return res.sendStatus(400);
    const connectorsRoot = join(root, 'connectors');
    for (const filename of ['logo.svg', 'logo.png']) {
      try {
        const file = containedFile(connectorsRoot, `${req.params.id}/${filename}`);
        return res.sendFile(file, { cacheControl: false, lastModified: false, dotfiles: 'deny' });
      } catch { /* Try the other supported format. */ }
    }
    return res.sendStatus(404);
  });
  app.get('/api/datasources', (req, res) => res.json({ success: true, sources: listDataSources() }));
  app.use('/api', (req, res) => res.status(403).json({ success: false, error: 'Endpoint is unavailable in preview' }));
  app.use((req, res) => {
    const pathname = decodeURIComponent(req.path);
    if (pathname === '/' || pathname === '/home' || pathname === '/settings') return res.redirect(302, '/visualizations');
    const isVizFile = pathname.startsWith('/viz/') && Boolean(extname(pathname));
    const isAppRoute = /^\/(visualizations|projects)$/.test(pathname) || /^\/viz\/[^/.]+$/.test(pathname) || /^\/project\/[^/.]+(?:\/[^/.]+)?$/.test(pathname);
    let file;
    try {
      if (isAppRoute) file = containedFile(appRoot, 'index.html');
      else if (isVizFile && assetTypes.has(extname(pathname).toLowerCase())) file = containedFile(vizRoot, pathname.slice('/viz/'.length));
      else if (!pathname.startsWith('/viz/') && assetTypes.has(extname(pathname).toLowerCase())) file = containedFile(appRoot, pathname.slice(1));
      else return res.sendStatus(404);
    } catch { return res.sendStatus(404); }
    res.sendFile(file, { cacheControl: false, lastModified: false, dotfiles: 'deny' });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status >= 400 && error.status < 500 ? error.status : 500).json({ success: false, error: 'Preview request failed' });
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, port: { type: 'string', default: '9232' }, credentials: { type: 'string' }, init: { type: 'boolean', default: false } } });
  if (!values.workspace || !values.credentials) throw new Error('Usage: node tools/preview/server.js --workspace PATH --credentials PATH [--init] [--port 9232]');
  const credentialPath = resolve(values.credentials);
  if (values.init) {
    mkdirSync(resolve(credentialPath, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(credentialPath, JSON.stringify({ password: randomBytes(32).toString('base64url') }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`Created credentials at ${credentialPath}; keep this file private.`);
  } else {
    if (statSync(credentialPath).mode & 0o077) throw new Error('Credential file permissions must be 0600');
    const { password } = JSON.parse(readFileSync(credentialPath, 'utf8'));
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1024 || port > 49151) throw new Error('Invalid port');
    const app = createPreviewApp({ workspace: values.workspace, password });
    const server = app.listen(port, '127.0.0.1', () => console.log(`LocalBase preview ready at http://127.0.0.1:${port} (${basename(resolve(values.workspace))})`));
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  }
}
