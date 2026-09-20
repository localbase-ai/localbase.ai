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
