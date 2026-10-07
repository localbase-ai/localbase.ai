import { join, resolve, sep } from 'path';

const SQLITE_FILE_REGEX = /\.(db|sqlite|sqlite3)$/i;
const READ_ONLY_QUERY_START_REGEX = /^(SELECT|WITH)\b/i;
const FORBIDDEN_SQL_KEYWORDS_REGEX = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|BEGIN|COMMIT|ROLLBACK)\b/i;

function makeStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function isWithinDirectory(targetPath, baseDir) {
  const resolvedTarget = resolve(targetPath);
  const resolvedBase = resolve(baseDir);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + sep);
}

function stripLeadingSqlComments(sql) {
  let remaining = sql.trimStart();

  while (remaining.length > 0) {
    if (remaining.startsWith('--')) {
      const newlineIndex = remaining.indexOf('\n');
      if (newlineIndex === -1) {
        return '';
      }
      remaining = remaining.slice(newlineIndex + 1).trimStart();
      continue;
    }

    if (remaining.startsWith('/*')) {
      const blockEndIndex = remaining.indexOf('*/');
      if (blockEndIndex === -1) {
        return '';
      }
      remaining = remaining.slice(blockEndIndex + 2).trimStart();
      continue;
    }

    break;
  }

  return remaining;
}

export function isAllowedReadOnlySqlQuery(sql) {
  if (typeof sql !== 'string') {
    return false;
  }

  const normalizedSql = stripLeadingSqlComments(sql);
  if (!READ_ONLY_QUERY_START_REGEX.test(normalizedSql)) {
    return false;
  }

  return !FORBIDDEN_SQL_KEYWORDS_REGEX.test(normalizedSql);
}

export function resolveWorkspaceDatabasePath(workspace, database) {
  if (typeof database !== 'string' || !database.trim()) {
    throw makeStatusError('Database path is required', 400);
  }

  if (database.includes('\0')) {
    throw makeStatusError('Database path contains invalid characters', 400);
  }

  if (database.includes('..')) {
    throw makeStatusError('Database path traversal not allowed', 403);
  }

  if (!SQLITE_FILE_REGEX.test(database)) {
    throw makeStatusError('Database path must point to a SQLite file', 400);
  }

  const dbPath = join(workspace, database);
  const dataDir = join(workspace, 'data');

  if (!isWithinDirectory(dbPath, dataDir)) {
    throw makeStatusError('Database path must stay within the workspace data directory', 403);
  }

  return { dbPath, dataDir };
}

/**
 * True when a Host header names this machine's loopback interface.
 *
 * The API binds to 127.0.0.1, but that alone does not stop DNS rebinding: a
 * page on evil.example can re-point its own name at 127.0.0.1, and the browser
 * then treats requests to evil.example:9220 as same-origin — no Origin header,
 * loopback socket, every other check passes. The Host header is the one thing
 * that still says evil.example, so anything that isn't a loopback name is
 * refused. The port is ignored: rebinding is about the name, not the port.
 *
 * @param {string|undefined} host Raw Host header
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const h = host.trim().toLowerCase();
  // [::1] or [::1]:port
  if (/^\[::1\](:\d+)?$/.test(h)) return true;
  const name = h.replace(/:\d+$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

// Filenames that hold credentials. Connectors keep OAuth tokens under
// data/<connector>/tokens.json, Google client files are oauth-credentials.json,
// and the preview server's password lives in auth.json.
const SENSITIVE_FILENAME_REGEX = new RegExp([
  '^env\\.local.*$', '^\\.env.*$', '^\\.gitignore$', '^auth\\.json$',
  // tokens.json, gmail_token.json, foo.token.json, refresh_token.txt, ...
  '(^|[._-])(access_|refresh_)?tokens?\\.(json|txt)$',
  // credentials.json, gmail_credentials.json, oauth-credentials.json, ...
  '(^|[._-])credentials?\\.json$',
  '^client_secret.*\\.json$', '^service[-_]account.*\\.json$',
  '\\.(pem|key|p12|pfx)$',
].join('|'), 'i');

/**
 * True when a workspace-relative path must never be served over HTTP.
 * Covers credential files anywhere, the .git directory, and data/preview/.
 *
 * @param {string} relativePath Path relative to the workspace root (leading slash optional)
 * @returns {boolean}
 */
export function isSensitiveWorkspacePath(relativePath) {
  if (typeof relativePath !== 'string') return true;
  const segments = relativePath.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
  if (segments.some(s => s.toLowerCase() === '.git')) return true;
  if (segments[0]?.toLowerCase() === 'data' && segments[1]?.toLowerCase() === 'preview') return true;
  const filename = segments[segments.length - 1] || '';
  return SENSITIVE_FILENAME_REGEX.test(filename);
}
