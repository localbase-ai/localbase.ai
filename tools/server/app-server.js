#!/usr/bin/env node

/**
 * LocalBase Insights Unified Server
 * Serves static files + handles visualization management API
 */

import express from 'express';
import { join, dirname, basename, normalize } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Enable require() for CommonJS modules
const require = createRequire(import.meta.url);
import { VizRegistry } from '../viz/registry.js';
import { unlinkSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import cors from 'cors';
import { spawnSync } from 'child_process';
import {
  detectWorkspaces,
  getCurrentWorkspace,
  setCurrentWorkspace,
  getConfigPath,
  isLocalBaseWorkspace,
  localbaseRoot
} from './workspace-config.js';
import { API_PORT, APP_PORT, ALLOWED_ORIGINS } from '../ports.js';
// import { CompanyCamConnector } from '../../connectors/companycam/index.js'; // REMOVED
import Database from 'better-sqlite3';
import { updateEnvContent } from './env-file.js';
import { isAllowedReadOnlySqlQuery, isLoopbackHost, isSensitiveWorkspacePath, isWithinDirectory, resolveWorkspaceDatabasePath } from './security-utils.js';

const __filename = fileURLToPath(import.meta.url);

/**
 * Calculate directory size recursively using native Node (no shell commands)
 * @param {string} dirPath - Directory to measure
 * @returns {number} Size in bytes
 */
function getDirectorySize(dirPath) {
  let totalSize = 0;
  try {
    const items = readdirSync(dirPath);
    for (const item of items) {
      const fullPath = join(dirPath, item);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          totalSize += stat.size;
        } else if (stat.isDirectory()) {
          totalSize += getDirectorySize(fullPath);
        }
      } catch (e) {
        // Skip files we can't access
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
  }
  return totalSize;
}

/**
 * Count files matching a pattern recursively using native Node
 * @param {string} dirPath - Directory to search
 * @param {string} extension - File extension to match (e.g., '.db')
 * @returns {number} Count of matching files
 */
function countFiles(dirPath, extension) {
  let count = 0;
  try {
    const items = readdirSync(dirPath);
    for (const item of items) {
      const fullPath = join(dirPath, item);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && item.endsWith(extension)) {
          count++;
        } else if (stat.isDirectory()) {
          count += countFiles(fullPath, extension);
        }
      } catch (e) {
        // Skip files we can't access
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
  }
  return count;
}

function getDataSourcesPaths(workspacePath) {
  const dataDir = join(workspacePath, 'data');
  return {
    local: join(dataDir, 'data-sources.local.json'),
    example: join(dataDir, 'data-sources.example.json')
  };
}

function getReadableDataSourcesFile(workspacePath) {
  const { local, example } = getDataSourcesPaths(workspacePath);
  if (existsSync(local)) return local;
  if (existsSync(example)) return example;
  return null;
}

function loadDataSources(workspacePath) {
  const filePath = getReadableDataSourcesFile(workspacePath);
  if (!filePath) {
    return { filePath: null, data: { sources: {} } };
  }

  const content = readFileSync(filePath, 'utf-8');
  return { filePath, data: JSON.parse(content) };
}

function persistLocalDataSources(workspacePath, data) {
  const { local } = getDataSourcesPaths(workspacePath);
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, JSON.stringify(data, null, 2));
  return local;
}

/**
 * In-flight and finished sync runs, keyed by data source id. Populated by
 * POST /api/datasources/:id/sync and read by its sync-status companion.
 * Deliberately in memory only: a restart loses history, which is fine because
 * the child processes die with the server anyway.
 */
const syncJobs = new Map();

/** Cap on retained stdout/stderr per sync job (bytes). */
const SYNC_OUTPUT_LIMIT = 64 * 1024;

/**
 * Format bytes to human readable string
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size (e.g., '1.5M', '200K')
 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'K';
  if (bytes < 1024 * 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}

/**
 * Sanitize a path for safe use in shell commands.
 * Rejects paths with characters that could enable command injection.
 * @param {string} p - The path to sanitize
 * @returns {string} The sanitized absolute path
 * @throws {Error} If path contains dangerous characters
 */
function sanitizePath(p) {
  // Resolve to absolute path first
  const resolved = normalize(p);

  // Check for shell metacharacters that could enable injection
  // Allow: alphanumeric, /, -, _, ., space (but not at start/end)
  const dangerousChars = /[`$&|;()<>{}!\\'"*?\[\]\n\r]/;
  if (dangerousChars.test(resolved)) {
    throw new Error('Path contains invalid characters');
  }

  // Prevent null bytes
  if (resolved.includes('\0')) {
    throw new Error('Path contains null bytes');
  }

  return resolved;
}

const CONNECTOR_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_ENV_VALUE_LENGTH = 4096;

function validateEnvKey(key) {
  if (typeof key !== 'string' || !ENV_KEY_REGEX.test(key)) {
    const error = new Error('Environment variable names must use only A-Z, 0-9, and underscores');
    error.code = 'INVALID_ENV_KEY';
    throw error;
  }
}

function validateEnvValue(value) {
  if (typeof value !== 'string') {
    const error = new Error('Environment variable values must be strings');
    error.code = 'INVALID_ENV_VALUE';
    throw error;
  }

  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    const error = new Error('Environment variable values cannot contain newlines or null bytes');
    error.code = 'INVALID_ENV_VALUE';
    throw error;
  }

  if (value.length > MAX_ENV_VALUE_LENGTH) {
    const error = new Error(`Environment variable values must be ${MAX_ENV_VALUE_LENGTH} characters or less`);
    error.code = 'INVALID_ENV_VALUE';
    throw error;
  }
}
const __dirname = dirname(__filename);

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const app = express();
const PORT = API_PORT;

// Get current workspace from persistent config (sanitize on load)
let currentWorkspace = sanitizePath(getCurrentWorkspace());

// Load env.local for API keys
const envLocalPath = join(currentWorkspace, 'env.local');
if (existsSync(envLocalPath)) {
  const envContent = readFileSync(envLocalPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex);
        const value = trimmed.substring(eqIndex + 1);
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  });
}

// Detect if running from framework (localbase.ai) vs instance
const cwd = process.cwd();
const frameworkRoot = join(dirname(__dirname), '..'); // tools/server -> tools -> root

// Viz directory at workspace root
function getVizDir(workspace) {
  return join(workspace, 'viz');
}

function ensureVizRegistry(workspace) {
  const workspaceVizDir = getVizDir(workspace);
  const registryPath = join(workspaceVizDir, 'visualizations.json');

  mkdirSync(workspaceVizDir, { recursive: true });

  if (!existsSync(registryPath)) {
    writeFileSync(
      registryPath,
      JSON.stringify({
        visualizations: [],
        lastUpdated: new Date().toISOString(),
        totalVisualizations: 0,
        totalViews: 0,
        version: '1.0'
      }, null, 2)
    );
  }

  return registryPath;
}

// Current viz directory
let vizDir = getVizDir(currentWorkspace);
ensureVizRegistry(currentWorkspace);

// Security headers middleware
app.use((req, res, next) => {
  res.header('X-Frame-Options', 'SAMEORIGIN');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-XSS-Protection', '1; mode=block');
  next();
});

// Localhost-only enforcement (can be disabled with LOCALBASE_ALLOW_REMOTE=true)
const ALLOW_REMOTE = process.env.LOCALBASE_ALLOW_REMOTE === 'true';

/**
 * True only for real loopback addresses.
 *
 * This used to be a substring test against a list containing '::1', which
 * matched any IPv6 address ending in ::1 — including public ones like
 * 2001:db8::1 and link-local fe80::1. Since ::1 is the conventional first
 * host address in a subnet and SLAAC lets a host pick its own interface
 * identifier, a machine on the same network could self-assign a matching
 * address and walk straight through this check.
 *
 * @param {string|undefined} rawIp Remote address as reported by the socket
 * @returns {boolean}
 */
function isLoopbackAddress(rawIp) {
  if (!rawIp) return false;
  // Drop an IPv6 zone index (fe80::1%en0) and the v4-mapped prefix.
  const ip = rawIp.replace(/%.*$/, '').replace(/^::ffff:/i, '');
  if (ip === '::1') return true;
  // All of 127.0.0.0/8 is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

app.use((req, res, next) => {
  if (ALLOW_REMOTE) {
    return next();
  }

  const clientIP = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress;

  const isLocalhost = isLoopbackAddress(clientIP);

  if (!isLocalhost) {
    console.warn(`⚠️  Blocked non-local request from ${clientIP}`);
    return res.status(403).json({
      error: 'LocalBase is configured for local access only',
      hint: 'Set LOCALBASE_ALLOW_REMOTE=true to allow remote access (not recommended)'
    });
  }

  next();
});

// API responses are data, never pages. If one is ever opened as a document —
// e.g. a viz navigating its frame to the app's /api proxy to land on the app's
// origin — the sandbox gives it an opaque origin, so it can't touch the app or
// pass the write-origin check. fetch() callers are unaffected.
app.use('/api', (req, res, next) => {
  res.set('Content-Security-Policy', 'sandbox allow-scripts allow-popups');
  next();
});

// DNS-rebinding guard. The loopback-socket check above can't tell a rebound
// evil.example (resolving to 127.0.0.1) from the real app; the Host header can.
// Skipped with LOCALBASE_ALLOW_REMOTE, where clients reach us by LAN name/IP.
app.use((req, res, next) => {
  if (ALLOW_REMOTE || isLoopbackHost(req.headers.host)) {
    return next();
  }
  console.warn(`⚠️  Blocked request with non-local Host header: ${req.headers.host}`);
  return res.status(403).json({ error: 'Invalid Host header' });
});

// Rate limiting - prevent abuse
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 200; // requests per window

app.use((req, res, next) => {
  const clientIP = req.ip || req.connection?.remoteAddress || '0.0.0.0';
  const now = Date.now();

  // Clean old entries
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now - data.windowStart > RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(ip);
    }
  }

  // Check rate limit
  let clientData = rateLimitMap.get(clientIP);
  if (!clientData || now - clientData.windowStart > RATE_LIMIT_WINDOW) {
    clientData = { windowStart: now, count: 0 };
    rateLimitMap.set(clientIP, clientData);
  }

  clientData.count++;

  if (clientData.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((clientData.windowStart + RATE_LIMIT_WINDOW - now) / 1000)
    });
  }

  next();
});

// CORS - only allow localhost origins
const allowedOrigins = ALLOWED_ORIGINS;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// CSRF protection: on mutating methods, require Origin/Referer to match an allowed
// origin when present. Browsers always send Origin on cross-origin POST/PUT/etc.,
// so a malicious site's form submit to localhost is rejected here. Non-browser
// clients (curl, tests, Node scripts) send neither and pass through — they're
// already gated by the localhost-only IP check above.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Writes come from the app (APP_PORT) only. Vizzes are served from this
// server's own origin, so excluding API_PORT means a viz — AI-written, showing
// data outsiders can influence — can read but never change anything.
const mutationOrigins = allowedOrigins.filter(o => !o.endsWith(`:${API_PORT}`));
app.use((req, res, next) => {
  if (!MUTATING_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (origin) {
    if (!mutationOrigins.includes(origin)) {
      console.warn(`⚠️  Blocked ${req.method} ${req.path} — disallowed Origin: ${origin}`);
      return res.status(403).json({ error: 'Invalid Origin' });
    }
    return next();
  }

  const referer = req.headers.referer;
  if (referer) {
    const refererOk = mutationOrigins.some(o => referer === o || referer.startsWith(o + '/'));
    if (!refererOk) {
      console.warn(`⚠️  Blocked ${req.method} ${req.path} — disallowed Referer: ${referer}`);
      return res.status(403).json({ error: 'Invalid Referer' });
    }
  }

  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Block access to sensitive files and path traversal
const SENSITIVE_FILES = ['env.local', '.env', 'credentials.json', '.git', '.gitignore'];
app.use((req, res, next) => {
  const path = decodeURIComponent(req.path);

  // Block path traversal
  if (path.includes('..')) {
    return res.status(403).json({ error: 'Path traversal not allowed' });
  }

  // Block sensitive files
  const filename = path.split('/').pop();
  if (SENSITIVE_FILES.some(f => filename === f || path.includes(`/${f}`))) {
    return res.status(403).json({ error: 'Access to sensitive files not allowed' });
  }

  // /data and /projects are served straight from the workspace, so their URL
  // paths are workspace-relative — which is what keeps connector OAuth tokens
  // (data/<connector>/tokens.json) and the preview password (data/preview/)
  // from being downloadable.
  if (/^\/(data|projects)(\/|$)/i.test(path) && isSensitiveWorkspacePath(path)) {
    return res.status(403).json({ error: 'Access to sensitive files not allowed' });
  }

  next();
});

// Initialize registry using viz directory at workspace root
let registry = new VizRegistry(vizDir);

console.log(`📁 Current workspace: ${currentWorkspace}`);
console.log(`📁 Config file: ${getConfigPath()}`);
console.log(`📁 Viz directory: ${vizDir}`);

/**
 * Switch to a different workspace
 * @param {string} workspacePath - Must be pre-sanitized via sanitizePath()
 */
function switchWorkspace(workspacePath) {
  // Double-check sanitization (defense in depth)
  currentWorkspace = sanitizePath(workspacePath);
  vizDir = getVizDir(currentWorkspace);
  ensureVizRegistry(currentWorkspace);

  // Re-initialize registry with new workspace viz dir
  registry = new VizRegistry(vizDir);

  // Persist workspace selection
  setCurrentWorkspace(currentWorkspace);

  console.log(`🔄 Switched to workspace: ${currentWorkspace}`);
  console.log(`📁 New registry path: ${registry.registryPath}`);
}

/**
 * GET /api/metrics/:metricId
 * Generic metrics API endpoint (FRAMEWORK CODE)
 * Reads metrics configuration from instance's metrics-config.js
 */
app.get('/api/metrics/:metricId', async (req, res) => {
  try {
    const { metricId } = req.params;
    const { startDate, endDate } = req.query;

    // Load metrics config from current workspace
    const metricsConfigPath = join(currentWorkspace, 'metrics-config.js');
    if (!existsSync(metricsConfigPath)) {
      return res.status(500).json({ error: 'Metrics configuration not found in workspace' });
    }

    const { default: metricsConfig } = await import(`file://${metricsConfigPath}`);
    const metric = metricsConfig.metrics[metricId];

    if (!metric) {
      return res.status(404).json({ error: `Metric '${metricId}' not found` });
    }

    let dbPath;
    try {
      ({ dbPath } = resolveWorkspaceDatabasePath(currentWorkspace, metric.database));
    } catch (pathError) {
      return res.status(pathError.statusCode || 400).json({ error: pathError.message });
    }

    const db = new Database(dbPath, { readonly: true });

    try {
      // Execute query with date parameters if provided
      const params = {};
      if (startDate && endDate) {
        params.startDate = startDate;
        params.endDate = endDate;
      }

      const stmt = db.prepare(metric.query);
      const result = stmt.get(params);

      db.close();

      res.json({
        metricId,
        value: result ? result.value : 0,
        label: metric.label,
        startDate: startDate || null,
        endDate: endDate || null,
        timestamp: new Date().toISOString()
      });

    } catch (dbError) {
      db.close();
      throw dbError;
    }

  } catch (error) {
    console.error(`❌ Metrics API error:`, error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/viz/:id
 * Delete a visualization by ID
 */
app.delete('/api/viz/:id', async (req, res) => {
  const { id } = req.params;

  console.log(`🗑️ Delete request for viz ID: ${id}`);

  try {
    // Get visualization info
    console.log(`🔍 Looking up viz ID: ${id}`);
    const allViz = await registry.getAll();
    console.log(`🔍 Registry contains ${allViz.length} visualizations:`, allViz.map(v => `${v.id}:${v.title}`));
    const viz = await registry.get(id);
    console.log(`🔍 Registry lookup result:`, viz ? `Found: ${viz.title}` : 'Not found');

    if (!viz) {
      console.log(`❌ Visualization not found in registry: ${id}`);
      return res.status(404).json({
        success: false,
        error: `Visualization not found: ${id}`
      });
    }

    console.log(`📋 Found viz: ${viz.title} (${viz.filename})`);

    // Delete the HTML file from viz folder
    // Prevent path traversal attacks - sanitize filename
    const safeFilename = basename(viz.filename);
    const vizPath = join(vizDir, safeFilename);

    // Verify the resolved path is still within viz directory
    const normalizedPath = normalize(vizPath);
    const normalizedVizDir = normalize(vizDir);
    if (!normalizedPath.startsWith(normalizedVizDir)) {
      console.error(`❌ Path traversal detected: ${viz.filename}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid file path'
      });
    }

    if (existsSync(vizPath)) {
      unlinkSync(vizPath);
      console.log(`🗂️ Deleted file: ${vizPath}`);
    } else {
      console.warn(`⚠️ File not found: ${vizPath}`);
    }

    // Remove from registry (this also saves the updated registry)
    await registry.unregister(id);

    console.log(`✅ Successfully deleted viz: ${viz.title}`);

    res.json({
      success: true,
      message: `Visualization "${viz.title}" deleted successfully`,
      deletedViz: {
        id: viz.id,
        title: viz.title,
        filename: viz.filename
      }
    });

  } catch (error) {
    console.error(`❌ Delete failed for ${id}:`, error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/viz
 * List all visualizations (for debugging)
 */
app.get('/api/viz', async (req, res) => {
  try {
    const allViz = await registry.getAll();
    const projectsWithPresentation = registry.getProjectsWithPresentation();
    const presentationCounts = registry.getPresentationCounts();
    const agentProjects = registry.getAgentProjects();
    res.json({
      success: true,
      visualizations: allViz,
      projectsWithPresentation,
      presentationCounts,
      agentProjects,
      total: allViz.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/viz/:id
 * Serve visualization by ID (moved to API namespace to avoid static file conflicts)
 */
app.get('/api/viz/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const viz = await registry.get(id);

    if (!viz) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Visualization Not Found</title></head>
        <body>
          <h1>Visualization Not Found</h1>
          <p>Visualization with ID "${escapeHtml(id)}" was not found.</p>
          <a href="/">← Back to Dashboard</a>
        </body>
        </html>
      `);
    }

    // Serve the actual HTML file
    const vizPath = join(vizDir, viz.filename);
    res.sendFile(vizPath);

    // Record view
    await registry.recordView(id);

  } catch (error) {
    console.error(`Error serving viz ${id}:`, error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Server Error</title></head>
      <body>
        <h1>Server Error</h1>
        <p>Error serving visualization: ${escapeHtml(error.message)}</p>
        <a href="/">← Back to Dashboard</a>
      </body>
      </html>
    `);
  }
});

/**
 * POST /api/viz/:id/pin
 * Toggle pin status for a visualization
 */
app.post('/api/viz/:id/pin', async (req, res) => {
  const { id } = req.params;
  const { pinned = false } = req.body || {};

  try {
    // Registry now in data/assets/
    const vizRegistryPath = join(vizDir, 'visualizations.json');
    if (!existsSync(vizRegistryPath)) {
      return res.json({ success: false, error: 'Visualization registry not found' });
    }

    const data = readFileSync(vizRegistryPath, 'utf-8');
    const registry = JSON.parse(data);

    // Find and update the visualization
    const vizIndex = registry.visualizations?.findIndex(v => v.id === id);
    if (vizIndex === -1 || vizIndex === undefined) {
      return res.json({ success: false, error: `Visualization not found: ${id}` });
    }

    registry.visualizations[vizIndex].pinned = pinned;
    writeFileSync(vizRegistryPath, JSON.stringify(registry, null, 2));

    res.json({
      success: true,
      message: `Visualization ${pinned ? 'pinned' : 'unpinned'} successfully`,
      viz: registry.visualizations[vizIndex]
    });
  } catch (error) {
    console.error('Error toggling pin:', error);
    res.json({ success: false, error: error.message });
  }
});

/**
 * GET /api/workspaces
 * List all available LocalBase workspaces
 */
app.get('/api/workspaces', (req, res) => {
  try {
    const workspaces = detectWorkspaces().map(ws => ({
      ...ws,
      active: ws.path === currentWorkspace
    }));
    res.json({
      success: true,
      workspaces,
      current: currentWorkspace
    });
  } catch (error) {
    console.error('Error listing workspaces:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/workspace/switch
 * Switch to a different workspace
 */
app.post('/api/workspace/switch', (req, res) => {
  try {
    const { path: workspacePath } = req.body;

    if (!workspacePath) {
      return res.status(400).json({
        success: false,
        error: 'Workspace path is required'
      });
    }

    // Sanitize path to prevent command injection
    let safePath;
    try {
      safePath = sanitizePath(workspacePath);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: 'Invalid workspace path: ' + e.message
      });
    }

    if (!isLocalBaseWorkspace(safePath)) {
      return res.status(404).json({
        success: false,
        error: 'Invalid workspace: expected LocalBase workspace structure'
      });
    }

    // Switch workspace (use sanitized path)
    switchWorkspace(safePath);

    res.json({
      success: true,
      workspace: currentWorkspace,
      message: `Switched to ${safePath.split('/').pop()}`
    });
  } catch (error) {
    console.error('Error switching workspace:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/workspace
 * Delete a workspace (removes the entire directory)
 */
app.delete('/api/workspace', (req, res) => {
  try {
    const { path: workspacePath } = req.body;

    if (!workspacePath) {
      return res.status(400).json({
        success: false,
        error: 'Workspace path is required'
      });
    }

    // Sanitize path
    let safePath;
    try {
      safePath = sanitizePath(workspacePath);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: 'Invalid workspace path: ' + e.message
      });
    }

    // Safety checks
    // 1. Must be in $LOCALBASE_ROOT directory
    const workDir = localbaseRoot();
    if (!isWithinDirectory(safePath, workDir)) {
      return res.status(403).json({
        success: false,
        error: 'Can only delete workspaces in $LOCALBASE_ROOT directory'
      });
    }

    // 2. Cannot delete the framework repo itself
    if (safePath.endsWith('/localbase.ai') || safePath.endsWith('/localbase.ai/')) {
      return res.status(403).json({
        success: false,
        error: 'Cannot delete the LocalBase framework'
      });
    }

    // 3. Must be a valid LocalBase workspace
    if (!isLocalBaseWorkspace(safePath)) {
      return res.status(400).json({
        success: false,
        error: 'Not a valid LocalBase workspace'
      });
    }

    // 4. Cannot delete current workspace
    if (safePath === currentWorkspace) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete the currently active workspace. Switch to a different workspace first.'
      });
    }

    // Delete the workspace directory
    const { rmSync } = require('fs');
    rmSync(safePath, { recursive: true, force: true });

    console.log(`🗑️ Deleted workspace: ${safePath}`);

    res.json({
      success: true,
      message: `Workspace deleted: ${safePath.split('/').pop()}`
    });
  } catch (error) {
    console.error('Error deleting workspace:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/workspace
 * Get current workspace information
 */
app.get('/api/workspace', (req, res) => {
  try {
    // Try to read package.json for workspace name
    const packagePath = join(currentWorkspace, 'package.json');
    let workspaceName = 'LocalBase';

    try {
      const packageData = JSON.parse(require('fs').readFileSync(packagePath, 'utf8'));
      workspaceName = packageData.name || workspaceName;
    } catch (e) {
      // Fallback to directory name if package.json doesn't exist or can't be read
      workspaceName = currentWorkspace.split('/').pop();
    }

    res.json({
      success: true,
      workspace: workspaceName,
      path: currentWorkspace
    });
  } catch (error) {
    console.error('Error getting workspace info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/workspace/stats
 * Returns detailed workspace statistics including file counts, sizes, etc.
 * Uses native Node.js for all file operations (no shell commands for security)
 */
app.get('/api/workspace/stats', (req, res) => {
  try {
    const workspaceName = currentWorkspace.split('/').pop();
    const stats = {
      workspace: workspaceName,
      path: currentWorkspace
    };

    // Get git repo size (native Node)
    try {
      const gitDir = join(currentWorkspace, '.git');
      if (existsSync(gitDir)) {
        const gitSizeBytes = getDirectorySize(gitDir);
        stats.gitRepoSize = formatSize(gitSizeBytes);
      }
    } catch (e) {
      stats.gitRepoSize = 'N/A';
    }

    // Get tracked files count (using git command safely via spawnSync)
    try {
      const result = spawnSync('git', ['ls-files'], {
        cwd: currentWorkspace,
        encoding: 'utf8'
      });
      if (result.status === 0) {
        const files = result.stdout.trim().split('\n').filter(f => f);
        stats.trackedFiles = files.length;
      } else {
        stats.trackedFiles = 0;
      }
    } catch (e) {
      stats.trackedFiles = 0;
    }

    // Get code + assets size (excluding node_modules and .git) - native Node
    try {
      const excludeDirs = ['node_modules', '.git', 'app/node_modules'];
      let codeSize = 0;

      const calcSize = (dir, depth = 0) => {
        if (depth > 10) return; // Prevent infinite recursion
        try {
          const items = readdirSync(dir);
          for (const item of items) {
            if (excludeDirs.includes(item)) continue;
            const fullPath = join(dir, item);
            try {
              const stat = statSync(fullPath);
              if (stat.isFile()) {
                codeSize += stat.size;
              } else if (stat.isDirectory()) {
                calcSize(fullPath, depth + 1);
              }
            } catch (e) {}
          }
        } catch (e) {}
      };

      calcSize(currentWorkspace);
      stats.codeSize = formatSize(codeSize);
    } catch (e) {
      stats.codeSize = 'N/A';
    }

    // Get node_modules size (native Node)
    try {
      const nodeModulesDir = join(currentWorkspace, 'node_modules');
      const appNodeModulesDir = join(currentWorkspace, 'app/node_modules');
      let totalSize = 0;

      if (existsSync(nodeModulesDir)) {
        totalSize += getDirectorySize(nodeModulesDir);
      }
      if (existsSync(appNodeModulesDir)) {
        totalSize += getDirectorySize(appNodeModulesDir);
      }

      stats.nodeModulesSize = formatSize(totalSize);
    } catch (e) {
      stats.nodeModulesSize = 'N/A';
    }

    // Get visualizations count (already native Node)
    try {
      const vizRegistryPath = join(vizDir, 'visualizations.json');
      if (existsSync(vizRegistryPath)) {
        const vizRegistry = JSON.parse(readFileSync(vizRegistryPath, 'utf8'));
        stats.visualizationCount = vizRegistry.visualizations?.length || 0;
      } else {
        stats.visualizationCount = 0;
      }
    } catch (e) {
      stats.visualizationCount = 0;
    }

    // Get connectors count (already native Node)
    try {
      const connectorsDir = join(currentWorkspace, 'connectors');
      if (existsSync(connectorsDir)) {
        const connectors = readdirSync(connectorsDir).filter(item => {
          const itemPath = join(connectorsDir, item);
          return statSync(itemPath).isDirectory() && !item.startsWith('.');
        });
        stats.connectorCount = connectors.length;
      } else {
        stats.connectorCount = 0;
      }
    } catch (e) {
      stats.connectorCount = 0;
    }

    // Get database files count and size (native Node)
    try {
      const dataDir = join(currentWorkspace, 'data');
      if (existsSync(dataDir)) {
        stats.databaseCount = countFiles(dataDir, '.db');
        stats.databaseSize = formatSize(getDirectorySize(dataDir));
      } else {
        stats.databaseCount = 0;
        stats.databaseSize = '0B';
      }
    } catch (e) {
      stats.databaseCount = 0;
      stats.databaseSize = '0B';
    }

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error getting workspace stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/workspace/framework-stats
 * Returns framework-specific statistics (tools/, web-app/, electron-app/)
 */
app.get('/api/workspace/framework-stats', (req, res) => {
  try {
    const frameworkDirs = ['tools', 'app', 'data', 'scripts'];

    // Check if current workspace is a subdirectory (like my-workspace)
    // If so, use parent directory for framework stats
    let frameworkRoot = currentWorkspace;
    const workspaceName = basename(currentWorkspace);
    if (workspaceName === 'my-workspace' || workspaceName.endsWith('-workspace')) {
      frameworkRoot = dirname(currentWorkspace);
    }

    // Calculate framework stats
    let instanceFiles = 0;
    let instanceSize = 0;
    let lastModified = null;

    // Count files recursively (native Node)
    const countFilesRecursive = (dir) => {
      let count = 0;
      try {
        const items = readdirSync(dir);
        for (const item of items) {
          const fullPath = join(dir, item);
          try {
            const stat = statSync(fullPath);
            if (stat.isFile()) count++;
            else if (stat.isDirectory()) count += countFilesRecursive(fullPath);
          } catch (e) {}
        }
      } catch (e) {}
      return count;
    };

    frameworkDirs.forEach(dir => {
      const dirPath = join(frameworkRoot, dir);
      if (existsSync(dirPath)) {
        try {
          instanceFiles += countFilesRecursive(dirPath);
          instanceSize += getDirectorySize(dirPath);

          const modTime = statSync(dirPath).mtime;
          if (!lastModified || modTime > lastModified) {
            lastModified = modTime;
          }
        } catch (e) {}
      }
    });

    // Format last modified
    const now = new Date();
    const diffMs = now - lastModified;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    let lastSyncFormatted = '—';
    if (lastModified) {
      if (diffDays === 0) {
        lastSyncFormatted = 'Today';
      } else if (diffDays === 1) {
        lastSyncFormatted = 'Yesterday';
      } else if (diffDays < 7) {
        lastSyncFormatted = diffDays + ' days ago';
      } else {
        lastSyncFormatted = lastModified.toLocaleDateString();
      }
    }

    res.json({
      success: true,
      framework: {
        files: instanceFiles,
        size: formatSize(instanceSize),  // Uses global formatSize helper
        lastModified: lastSyncFormatted
      }
    });
  } catch (error) {
    console.error('Error getting framework stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/workspace/node-modules-breakdown
 * Returns detailed breakdown of entire framework repo by directory/file
 * Uses native Node.js for all file operations (no shell commands for security)
 */
app.get('/api/workspace/node-modules-breakdown', (req, res) => {
  try {
    // Check if current workspace is a subdirectory (like my-workspace)
    let frameworkRoot = currentWorkspace;
    const workspaceName = basename(currentWorkspace);
    if (workspaceName === 'my-workspace' || workspaceName.endsWith('-workspace')) {
      frameworkRoot = dirname(currentWorkspace);
    }

    const items = [];

    // Get node_modules breakdown (top packages) - native Node
    const nodeModulesDir = join(frameworkRoot, 'node_modules');
    if (existsSync(nodeModulesDir)) {
      const packages = readdirSync(nodeModulesDir)
        .filter(item => {
          const itemPath = join(nodeModulesDir, item);
          try {
            return statSync(itemPath).isDirectory();
          } catch (e) {
            return false;
          }
        })
        .map(packageName => {
          const packagePath = join(nodeModulesDir, packageName);
          try {
            const sizeBytes = getDirectorySize(packagePath);
            const sizeKB = Math.round(sizeBytes / 1024);
            const sizeMB = sizeBytes / (1024 * 1024);

            return {
              name: packageName,
              sizeMB: Math.round(sizeMB * 100) / 100,
              sizeKB: sizeKB,
              category: 'node_modules'
            };
          } catch (e) {
            return null;
          }
        })
        .filter(p => p !== null)
        .sort((a, b) => b.sizeKB - a.sizeKB);

      // Add top 15 packages individually
      items.push(...packages.slice(0, 15));

      // Group remaining packages as "other node_modules"
      const remainingSize = packages.slice(15).reduce((sum, p) => sum + p.sizeMB, 0);
      if (remainingSize > 0) {
        items.push({
          name: 'other node_modules',
          sizeMB: Math.round(remainingSize * 100) / 100,
          category: 'node_modules'
        });
      }
    }

    // Get framework directories - native Node
    const frameworkDirs = ['tools', 'app', 'connectors', 'data', 'scripts'];
    frameworkDirs.forEach(dir => {
      const dirPath = join(frameworkRoot, dir);
      if (existsSync(dirPath)) {
        try {
          const sizeBytes = getDirectorySize(dirPath);
          const sizeKB = Math.round(sizeBytes / 1024);
          const sizeMB = sizeBytes / (1024 * 1024);
          items.push({
            name: dir,
            sizeMB: Math.round(sizeMB * 100) / 100,
            sizeKB: sizeKB,
            category: 'framework'
          });
        } catch (e) {}
      }
    });

    // Sort all items by size
    items.sort((a, b) => (b.sizeKB || b.sizeMB * 1024) - (a.sizeKB || a.sizeMB * 1024));

    res.json({
      success: true,
      items: items,
      total: items.reduce((sum, item) => sum + item.sizeMB, 0)
    });
  } catch (error) {
    console.error('Error analyzing framework:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/tools
 * List tools from workspace tools/ that have a config.json
 */
app.get('/api/tools', (req, res) => {
  try {
    const tools = [];

    // Scan tools/ for subdirectories with a config.json
    const toolsPath = join(currentWorkspace, 'tools');
    if (existsSync(toolsPath)) {
      const entries = readdirSync(toolsPath).filter(item => {
        const itemPath = join(toolsPath, item);
        return statSync(itemPath).isDirectory() && !item.startsWith('.');
      });

      for (const entry of entries) {
        const configPath = join(toolsPath, entry, 'config.json');
        if (existsSync(configPath)) {
          try {
            const config = JSON.parse(readFileSync(configPath, 'utf8'));
            tools.push({
              id: entry,
              name: config.name || entry.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
              description: config.description || `${entry} tool`,
              version: config.version || '1.0.0',
              type: 'tools',
              config
            });
          } catch (e) {
            console.error(`Failed to parse config for ${entry}:`, e.message);
          }
        }
      }
    }

    console.log(`🔧 Found ${tools.length} tools in ${currentWorkspace}`);
    res.json({ success: true, tools, total: tools.length });
  } catch (error) {
    console.error('Error listing tools:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tools/:toolId/config
 * Get a specific tool's config
 */
app.get('/api/tools/:toolId/config', (req, res) => {
  try {
    const { toolId } = req.params;

    if (!CONNECTOR_ID_REGEX.test(toolId)) {
      return res.status(400).json({ success: false, error: 'Invalid tool id' });
    }

    const toolsDir = join(currentWorkspace, 'tools');
    const configPath = join(toolsDir, toolId, 'config.json');
    if (!isWithinDirectory(configPath, toolsDir)) {
      return res.status(400).json({ success: false, error: 'Invalid path' });
    }
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      return res.json({ success: true, config });
    }

    res.status(404).json({ success: false, error: `Tool config not found: ${toolId}` });
  } catch (error) {
    console.error('Error getting tool config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/connectors
 * List connectors from workspace with status and lastSync
 */
app.get('/api/connectors', (req, res) => {
  try {
    const connectors = [];
    const connectorsDir = join(currentWorkspace, 'connectors');

    if (existsSync(connectorsDir)) {
      const connectorDirs = readdirSync(connectorsDir).filter(item => {
        const itemPath = join(connectorsDir, item);
        return statSync(itemPath).isDirectory() && !item.startsWith('.') && item !== 'example';
      });

      for (const dir of connectorDirs) {
        const connectorPath = join(connectorsDir, dir);
        const indexPath = join(connectorPath, 'index.js');

        // Check for index.js
        if (!existsSync(indexPath)) {
          connectors.push({
            id: dir,
            name: dir.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
            status: 'missing-index',
            description: 'Missing index.js - connector not functional',
            lastSync: 'N/A',
            path: connectorPath
          });
          continue;
        }

        // Look for data directory to determine lastSync
        let lastSync = 'Never';
        let dataDir = null;

        // Try to find schema.json with data_location
        const schemaPath = join(connectorPath, 'schema.json');
        if (existsSync(schemaPath)) {
          try {
            const schemaData = readFileSync(schemaPath, 'utf-8');
            const schema = JSON.parse(schemaData);
            if (schema.data_location) {
              // e.g., "data/g2-visits/file.csv" -> "data/g2-visits"
              const locationParts = schema.data_location.split('/');
              if (locationParts.length >= 2 && locationParts[0] === 'data') {
                dataDir = join(currentWorkspace, locationParts[0], locationParts[1]);
              }
            }
          } catch {
            // Schema file exists but couldn't read it
          }
        }

        // Fallback: name-based lookup - try multiple patterns
        if (!dataDir) {
          const possibleDirs = [
            join(currentWorkspace, 'data', dir.replace(/-/g, '_')),  // g2-api -> g2_api
            join(currentWorkspace, 'data', dir),                      // exact match
            join(currentWorkspace, 'data', `${dir.replace(/-/g, '_')}_contacts`),  // hubspot -> hubspot_contacts
            join(currentWorkspace, 'data', `${dir.replace(/-/g, '_')}_deals`),     // hubspot -> hubspot_deals
            join(currentWorkspace, 'data', `${dir.replace(/-/g, '_')}_companies`), // hubspot -> hubspot_companies
            join(currentWorkspace, 'data', `${dir.replace(/-/g, '_')}_meetings`),  // hubspot -> hubspot_meetings
            join(currentWorkspace, 'data', `${dir.replace(/-api$/, '').replace(/-/g, '-')}-visits`), // g2-api -> g2-visits
          ];

          for (const possibleDir of possibleDirs) {
            if (existsSync(possibleDir)) {
              dataDir = possibleDir;
              break;
            }
          }
        }

        // Check for recent data files
        if (dataDir && existsSync(dataDir)) {
          try {
            const dirStat = statSync(dataDir);
            if (dirStat.isDirectory()) {
              const dataFiles = readdirSync(dataDir).filter(f => !f.startsWith('.'));
              let mostRecentTime = 0;

              for (const file of dataFiles) {
                const filePath = join(dataDir, file);
                try {
                  const fileStat = statSync(filePath);
                  if (fileStat.isFile() && fileStat.mtime.getTime() > mostRecentTime) {
                    mostRecentTime = fileStat.mtime.getTime();
                  }
                } catch {
                  // Skip files we can't stat
                }
              }

              if (mostRecentTime > 0) {
                lastSync = new Date(mostRecentTime).toISOString().split('T')[0];
              }
            }
          } catch {
            // No data directory or can't read it
          }
        }

        // Get description from package.json or README
        let description = '';
        const pkgPath = join(connectorPath, 'package.json');
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            description = pkg.description || '';
          } catch {
            // Ignore parse errors
          }
        }

        connectors.push({
          id: dir,
          name: dir.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          status: lastSync && lastSync !== 'Never' ? 'active' : 'needs-fix',
          description,
          lastSync,
          path: connectorPath
        });
      }
    }

    res.json({ success: true, connectors, total: connectors.length });
  } catch (error) {
    console.error('Error listing connectors:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/connectors/:id/logo
 * Serve connector logo from connectors/<id>/logo.{svg,png}
 */
app.get('/api/connectors/:id/logo', (req, res) => {
  const { id } = req.params;
  if (!CONNECTOR_ID_REGEX.test(id)) {
    return res.status(400).send('Invalid connector id');
  }
  const connectorsDir = join(currentWorkspace, 'connectors');
  const connectorPath = join(connectorsDir, id);
  if (!isWithinDirectory(connectorPath, connectorsDir)) {
    return res.status(400).send('Invalid path');
  }
  for (const [ext, type] of [['svg', 'image/svg+xml'], ['png', 'image/png']]) {
    const logoPath = join(connectorPath, `logo.${ext}`);
    if (existsSync(logoPath)) {
      res.set('Cache-Control', 'public, max-age=3600');
      res.type(type);
      return res.sendFile(logoPath);
    }
  }
  res.status(404).send('No logo');
});

/**
 * POST /api/connectors/install
 * Install a connector template to the current workspace
 */
app.post('/api/connectors/install', (req, res) => {
  try {
    const { connectorId } = req.body;

    if (!connectorId) {
      return res.status(400).json({
        success: false,
        error: 'connectorId is required'
      });
    }

    if (typeof connectorId !== 'string' || !CONNECTOR_ID_REGEX.test(connectorId)) {
      return res.status(400).json({
        success: false,
        error: 'connectorId must use only letters, numbers, and dashes'
      });
    }

    // Connector template sources - check other LocalBase instances for connector templates
    // This allows copying connectors between instances without manual file management
    const templateSources = detectWorkspaces()
      .filter(ws => ws.path !== currentWorkspace)
      .map(ws => join(ws.path, 'connectors', connectorId));

    // Find the template
    let templatePath = null;
    for (const source of templateSources) {
      if (existsSync(source)) {
        templatePath = source;
        break;
      }
    }

    if (!templatePath) {
      return res.status(404).json({
        success: false,
        error: `Connector template '${connectorId}' not found`
      });
    }

    // Target path in current workspace
    const targetPath = join(currentWorkspace, 'connectors', connectorId);

    // Check if already installed
    if (existsSync(targetPath)) {
      return res.status(400).json({
        success: false,
        error: `Connector '${connectorId}' is already installed`
      });
    }

    // Copy the connector directory
    const { cpSync } = require('fs');
    cpSync(templatePath, targetPath, { recursive: true });

    console.log(`📦 Installed connector: ${connectorId} from ${templatePath}`);

    res.json({
      success: true,
      message: `Connector '${connectorId}' installed successfully`,
      path: targetPath
    });
  } catch (error) {
    console.error('Error installing connector:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/env/save
 * Save environment variables to env.local
 */
app.post('/api/env/save', (req, res) => {
  try {
    const { vars } = req.body;

    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
      return res.status(400).json({
        success: false,
        error: 'vars object is required'
      });
    }

    // Check for empty vars object
    if (Object.keys(vars).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'vars object cannot be empty'
      });
    }

    const envPath = join(currentWorkspace, 'env.local');

    // Validate everything before touching the file.
    try {
      Object.entries(vars).forEach(([key, value]) => {
        validateEnvKey(key);
        if (value !== undefined && value !== '' && value !== null) validateEnvValue(value);
      });
    } catch (validationError) {
      if (validationError.code === 'INVALID_ENV_KEY' || validationError.code === 'INVALID_ENV_VALUE') {
        return res.status(400).json({
          success: false,
          error: validationError.message
        });
      }
      throw validationError;
    }

    // Edit in place: comments, blank lines and ordering survive (env-file.js).
    const existingContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
    const { content: newContent, updated: updatedCount, deleted: deletedCount } = updateEnvContent(existingContent, vars);

    // Owner-only: env.local holds API keys. mode only applies on create, so chmod too.
    writeFileSync(envPath, newContent, { mode: 0o600 });
    chmodSync(envPath, 0o600);
    console.log(`💾 Saved ${Object.keys(vars).length} env vars to ${envPath}`);

    res.json({
      success: true,
      message: `Updated ${updatedCount} environment variables${deletedCount ? ` and deleted ${deletedCount}` : ''}`
    });
  } catch (error) {
    console.error('Error saving env vars:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/env/:key
 * Read a single public env var. Only whitelisted keys are exposed.
 */
const PUBLIC_ENV_KEYS = ['MAPBOX_TOKEN'];
app.get('/api/env/:key', (req, res) => {
  const { key } = req.params;
  if (!PUBLIC_ENV_KEYS.includes(key)) {
    return res.status(403).json({ success: false, error: 'Key not available' });
  }
  res.json({ success: true, value: process.env[key] || null });
});

/**
 * POST /api/datasources/:id/sync
 * Run sync for a data source
 */
app.post('/api/datasources/:id/sync', async (req, res) => {
  try {
    const { id } = req.params;

    // Load local runtime config first, then fall back to the tracked example
    const { filePath: dataSourcesFile, data: dataSourcesData } = loadDataSources(currentWorkspace);
    if (!dataSourcesFile) {
      return res.status(404).json({ success: false, error: 'No data sources config found' });
    }
    const source = dataSourcesData.sources?.[id];

    if (!source) {
      return res.status(404).json({ success: false, error: `Data source '${id}' not found` });
    }

    // Support both sync_script and update_command
    const syncCommand = source.sync_script || source.update_command;
    if (!syncCommand) {
      return res.status(400).json({ success: false, error: `Data source '${id}' has no sync_script or update_command configured` });
    }

    // Extract script path (strip "node " prefix if present)
    const scriptPath = syncCommand.startsWith('node ')
      ? syncCommand.replace('node ', '')
      : syncCommand;

    // Security: Validate script path has no shell metacharacters
    const dangerousChars = /[;|&`$(){}!\\'"<>*?\[\]\n\r]/;
    if (dangerousChars.test(scriptPath)) {
      return res.status(400).json({
        success: false,
        error: 'Script path contains invalid characters'
      });
    }

    const fullScriptPath = join(currentWorkspace, scriptPath);

    // Security: Ensure resolved path is within workspace
    const normalizedScript = normalize(fullScriptPath);
    const normalizedWorkspace = normalize(currentWorkspace);
    if (!normalizedScript.startsWith(normalizedWorkspace + '/')) {
      return res.status(400).json({
        success: false,
        error: 'Script path must be within workspace'
      });
    }

    if (!existsSync(fullScriptPath)) {
      return res.status(404).json({ success: false, error: `Sync script not found: ${scriptPath}` });
    }

    // Refuse to start a second run of the same source rather than racing it.
    const running = syncJobs.get(id);
    if (running && running.status === 'running') {
      return res.status(409).json({
        success: false,
        error: `Sync for '${id}' is already running (started ${running.startedAt})`,
        status: 'running'
      });
    }

    console.log(`🔄 Running sync for ${id}: node ${scriptPath}`);

    // Security: array args, never a shell string, so the path cannot inject.
    //
    // spawn, NOT spawnSync: spawnSync blocks Node's single event loop for the
    // whole run, so the entire server — every other endpoint, every viz fetch —
    // stops answering until the child exits. It also forced a timeout ceiling,
    // and real syncs run well past any sane ceiling (a large connector takes ~40
    // minutes), so those syncs could never finish from the UI at all.
    const { spawn } = await import('child_process');
    const child = spawn('node', [fullScriptPath], {
      cwd: currentWorkspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: process.env.NODE_ENV
        // Only pass safe env vars, not secrets. Connectors read their own
        // credentials from env.local via dotenv, so this does not starve them.
      }
    });

    const job = {
      id,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      error: null,
      lastSync: null,
      output: ''
    };
    syncJobs.set(id, job);

    // Keep only the tail. A long sync can emit megabytes of progress logs and
    // this map lives for the life of the process.
    const appendOutput = (buf) => {
      job.output = (job.output + buf.toString()).slice(-SYNC_OUTPUT_LIMIT);
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);

    child.on('error', (err) => {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = err.message;
      console.error(`❌ Sync for ${id} failed to start:`, err.message);
    });

    child.on('close', (code) => {
      // 'error' already settled this job; a close still follows a spawn failure.
      if (job.status !== 'running') return;

      job.finishedAt = new Date().toISOString();
      job.exitCode = code;

      if (code !== 0) {
        job.status = 'failed';
        job.error = `Process exited with code ${code}`;
        console.error(`❌ Sync failed for ${id} (exit ${code})`);
        return;
      }

      job.status = 'completed';
      console.log(`✅ Sync completed for ${id}`);

      // Re-read the config instead of reusing the copy captured when the
      // request arrived. The run is long enough that another source's sync can
      // finish in the meantime, and writing back the stale object would erase
      // the last_sync it just recorded.
      try {
        const { filePath, data: fresh } = loadDataSources(currentWorkspace);
        if (!filePath || !fresh.sources?.[id]) {
          console.warn(`⚠️  Sync for ${id} finished but its config entry is gone — skipping last_sync`);
          return;
        }
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        fresh.sources[id].last_sync = today;
        const localDataSourcesFile = persistLocalDataSources(currentWorkspace, fresh);
        job.lastSync = today;
        console.log(`📅 Updated last_sync for ${id} to ${today} in ${localDataSourcesFile}`);
      } catch (err) {
        console.error(`⚠️  Sync for ${id} succeeded but last_sync could not be written:`, err.message);
      }
    });

    // Hand back immediately; the client polls the status endpoint below.
    res.status(202).json({ success: true, status: 'started', id, startedAt: job.startedAt });
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      output: ''
    });
  }
});

/**
 * GET /api/datasources/:id/sync-status
 * Progress for a sync started by the endpoint above. Jobs are held in memory,
 * so a server restart forgets them and the source reports as idle again.
 */
app.get('/api/datasources/:id/sync-status', (req, res) => {
  const job = syncJobs.get(req.params.id);
  if (!job) {
    return res.json({ success: true, status: 'idle' });
  }
  res.json({ success: true, ...job });
});

/**
 * GET /api/datasources
 * List data sources from local runtime config or tracked example config
 */
app.get('/api/datasources', (req, res) => {
  try {
    const { filePath: dataSourcesFile, data } = loadDataSources(currentWorkspace);

    if (dataSourcesFile) {
      // Return sources object directly - matches what Overview.jsx expects
      res.json({ success: true, sources: data.sources || {} });
    } else {
      // Fallback: scan for .db files if no config exists
      const dataSources = [];
      const dataDir = join(currentWorkspace, 'data');

      if (existsSync(dataDir)) {
        const findDbs = (dir, prefix = '') => {
          const items = readdirSync(dir);
          for (const item of items) {
            const itemPath = join(dir, item);
            const stat = statSync(itemPath);
            if (stat.isDirectory()) {
              findDbs(itemPath, prefix ? `${prefix}/${item}` : item);
            } else if (item.endsWith('.db')) {
              dataSources.push({
                id: prefix ? `${prefix}/${item}` : item,
                name: item.replace('.db', ''),
                path: itemPath,
                size: stat.size,
                modified: stat.mtime
              });
            }
          }
        };
        findDbs(dataDir);
      }

      // Convert array to sources object for consistency
      const sources = {};
      dataSources.forEach(ds => {
        sources[ds.id] = { name: ds.name, path: ds.path };
      });
      res.json({ success: true, sources });
    }
  } catch (error) {
    console.error('Error listing data sources:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/workspace/file
 * Read a file from the workspace
 * ?path=relative/path/to/file.json
 */
app.get('/api/workspace/file', (req, res) => {
  try {
    const { path: relativePath } = req.query;

    if (!relativePath) {
      return res.status(400).json({
        success: false,
        error: 'path query parameter required'
      });
    }

    // Security: Block path traversal
    if (relativePath.includes('..')) {
      return res.status(403).json({
        success: false,
        error: 'Path traversal not allowed'
      });
    }

    // Security: Block sensitive files
    const filename = relativePath.split('/').pop();
    if (SENSITIVE_FILES.some(f => filename === f || relativePath.includes(f)) || isSensitiveWorkspacePath(relativePath)) {
      return res.status(403).json({
        success: false,
        error: 'Access to sensitive files not allowed'
      });
    }

    const filePath = join(currentWorkspace, relativePath);

    if (!existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: `File not found: ${relativePath}`
      });
    }

    const content = readFileSync(filePath, 'utf8');
    res.json({ success: true, content });
  } catch (error) {
    console.error('Error reading workspace file:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/db/query
 * Execute SQL query against a workspace database
 * Body: { database: "path/to/db.sqlite", sql: "SELECT ...", params: [] }
 */
app.post('/api/db/query', (req, res) => {
  try {
    const { database, sql, params = [] } = req.body;

    if (!database || !sql) {
      return res.status(400).json({
        success: false,
        error: 'database and sql are required'
      });
    }

    if (!Array.isArray(params)) {
      return res.status(400).json({
        success: false,
        error: 'params must be an array'
      });
    }

    if (typeof database !== 'string' || database.includes('..')) {
      return res.status(403).json({
        success: false,
        error: 'Database path traversal not allowed'
      });
    }

    if (!isAllowedReadOnlySqlQuery(sql)) {
      return res.status(400).json({
        success: false,
        error: 'Only read-only SELECT queries are allowed'
      });
    }

    let dbPath;
    try {
      ({ dbPath } = resolveWorkspaceDatabasePath(currentWorkspace, database));
    } catch (pathError) {
      return res.status(pathError.statusCode || 400).json({
        success: false,
        error: pathError.message
      });
    }

    if (!existsSync(dbPath)) {
      return res.status(404).json({
        success: false,
        error: `Database not found: ${database}`
      });
    }

    const db = new Database(dbPath, { readonly: true });

    try {
      const stmt = db.prepare(sql);
      const result = stmt.all(...params);

      db.close();

      res.json({
        success: true,
        data: result
      });
    } catch (queryError) {
      db.close();
      console.error('Database query execution error:', queryError);
      return res.status(400).json({
        success: false,
        error: 'Query execution failed'
      });
    }
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================================================
// SEARCH API
// =============================================================================

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'localbase-insights-server',
    port: PORT
  });
});

/**
 * Serve viz files from workspace viz/ directory
 * Dynamic middleware that uses current vizDir (updates on workspace switch)
 */
// Only the app may frame a viz. Replaces the blanket SAMEORIGIN, which would
// block the app (a different port, so a different origin) from showing it.
const VIZ_FRAME_ANCESTORS = `frame-ancestors 'self' ${allowedOrigins.filter(o => o.endsWith(`:${APP_PORT}`)).join(' ')}`;
const VIZ_BRIDGE_TAG = `<script>${readFileSync(new URL('./viz-bridge.js', import.meta.url), 'utf8')}</script>`;
const setVizHeaders = (res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.removeHeader('X-Frame-Options');
  res.set('Content-Security-Policy', VIZ_FRAME_ANCESTORS);
};

/**
 * Viz HTML gets the key/scroll bridge injected (see viz-bridge.js); everything
 * else under /viz is served as-is.
 */
app.use('/viz', (req, res, next) => {
  if (req.method !== 'GET' || !/\.html?$/i.test(req.path)) return next();
  let file;
  try { file = join(vizDir, decodeURIComponent(req.path)); } catch { return res.sendStatus(400); }
  if (!isWithinDirectory(file, vizDir) || !existsSync(file) || !statSync(file).isFile()) return next();
  const html = readFileSync(file, 'utf8');
  const at = html.search(/<\/head>/i);
  setVizHeaders(res);
  res.type('html').send(at === -1 ? VIZ_BRIDGE_TAG + html : html.slice(0, at) + VIZ_BRIDGE_TAG + html.slice(at));
});

app.use('/viz', (req, res, next) => {
  express.static(vizDir, { setHeaders: setVizHeaders })(req, res, next);
});

/**
 * Serve data files from workspace data/ directory
 * Used by visualizations to load SQLite databases client-side
 */
app.use('/data', (req, res, next) => {
  const dataDir = join(currentWorkspace, 'data');
  express.static(dataDir, {
    setHeaders: (res, path) => {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  })(req, res, next);
});

/**
 * Serve project files from workspace projects/ directory
 * Lets play/project docs link to assets (PDFs, CSVs, etc.) by repo path
 */
app.use('/projects', (req, res, next) => {
  const projectsDir = join(currentWorkspace, 'projects');
  express.static(projectsDir, {
    setHeaders: (res, path) => {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  })(req, res, next);
});

// Note: UI is served by the Vite dev server (APP_PORT) during development.
// This port (API_PORT) is API-only. For production, run `npm run build` and serve app/dist separately.

/**
 * Start the server
 * @returns {Promise<import('http').Server>} The HTTP server instance
 */
async function startServer() {
  return new Promise((resolve) => {
    // Bind loopback only. The middleware above already rejects non-local
    // callers, but not listening on other interfaces means a misconfigured
    // guard can't turn into remote data access on its own.
    const BIND_HOST = ALLOW_REMOTE ? '0.0.0.0' : '127.0.0.1';
    const server = app.listen(PORT, BIND_HOST, () => {
      console.log(`🚀 LocalBase API server running on http://localhost:${PORT}`);
      console.log(`📁 Viz served from: ${vizDir}`);
      console.log(`📋 API endpoints:`);
      console.log(`   GET    /api/workspaces         - List available workspaces`);
      console.log(`   POST   /api/workspace/switch   - Switch to different workspace`);
      console.log(`   GET    /api/workspace          - Current workspace info`);
      console.log(`   DELETE /api/viz/:id            - Delete visualization`);
      console.log(`   GET    /api/viz                - List all visualizations`);
      console.log(`   GET    /health                 - Health check`);
      console.log(`   GET    /*                      - Static files`);
      resolve(server);
    });
  });
}

// Export for testing
export { app, startServer, PORT };

// Start server if run directly (not imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  startServer();
}
