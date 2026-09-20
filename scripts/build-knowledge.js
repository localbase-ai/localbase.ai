#!/usr/bin/env node

/**
 * Knowledge Builder — Introspects all SQLite databases in data/
 * and generates a knowledge/schemas.md file that describes every
 * table, its columns, row counts, and sample data.
 *
 * Usage: node scripts/build-knowledge.js [workspace]
 *        Defaults to current working directory.
 *
 * Output: knowledge/schemas.md (auto-generated, do not edit)
 */

import Database from 'better-sqlite3';
import { readdirSync, statSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, relative, basename } from 'path';

const workspace = process.argv[2] || process.cwd();
const dataDir = join(workspace, 'data');
const knowledgeDir = join(workspace, 'knowledge');

// Allow-list of DB paths whose sample rows are safe to emit into
// knowledge/schemas.md. Default = elide samples (columns + counts only) so
// PII / business-sensitive fields don't leak into the index. Each instance
// opts in by listing its safe DBs in data/sample-allowlist.json (an array
// of workspace-relative paths). Missing file → empty set → all elided.
function loadSampleAllowlist() {
  const p = join(dataDir, 'sample-allowlist.json');
  if (!existsSync(p)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (Array.isArray(parsed)) return new Set(parsed);
  } catch { /* ignore — fail closed */ }
  return new Set();
}
const SAMPLE_ALLOWLIST = loadSampleAllowlist();

// Collect all .db and .sqlite files recursively under data/
function findDatabases(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      findDatabases(full, files);
    } else if (entry.endsWith('.db') || entry.endsWith('.sqlite')) {
      // Skip empty files and system databases
      if (stat.size > 0 && entry !== 'conversations.db') {
        files.push(full);
      }
    }
  }
  return files;
}

// Introspect a single database
function introspect(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all();

  const result = { path: relative(workspace, dbPath), tables: [] };

  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info('${name}')`).all();
    const count = db.prepare(`SELECT COUNT(*) as n FROM '${name}'`).get().n;

    // Grab up to 3 sample rows
    let samples = [];
    if (count > 0) {
      samples = db.prepare(`SELECT * FROM '${name}' LIMIT 3`).all();
    }

    // Get indexes
    const indexes = db.prepare(`PRAGMA index_list('${name}')`).all();

    result.tables.push({ name, columns, count, samples, indexes });
  }

  db.close();
  return result;
}

// Format a database introspection as markdown
function formatDatabase(info) {
  let md = `### ${info.path}\n\n`;
  const samplesAllowed = SAMPLE_ALLOWLIST.has(info.path);
  if (!samplesAllowed) {
    md += `> Sample rows elided — DB may contain PII or sensitive business data.\n\n`;
  }

  for (const table of info.tables) {
    md += `#### \`${table.name}\` (${table.count.toLocaleString()} rows)\n\n`;

    // Column names that match email/phone patterns are redacted — broken CSV
    // imports occasionally promote a data row into a column header.
    md += `| Column | Type | Nullable | Default |\n`;
    md += `|--------|------|----------|---------|\n`;
    for (const col of table.columns) {
      const nullable = col.notnull ? 'NO' : 'YES';
      const def = col.dflt_value ?? '';
      const pk = col.pk ? ' **PK**' : '';
      let name = col.name;
      if (/^[\w.%+-]+@[\w.-]+\.[a-zA-Z]{2,}$/.test(name)) name = '<redacted-email>';
      else if (/^\+?[\d][\d\s().-]{8,}$/.test(name)) name = '<redacted-phone>';
      md += `| ${name}${pk} | ${col.type || 'TEXT'} | ${nullable} | ${def} |\n`;
    }
    md += '\n';

    // Indexes
    if (table.indexes.length > 0) {
      md += `**Indexes:** ${table.indexes.map(i => `\`${i.name}\``).join(', ')}\n\n`;
    }

    // Sample data
    if (table.samples.length > 0 && samplesAllowed) {
      md += `<details><summary>Sample rows</summary>\n\n`;
      md += '```json\n';
      // Truncate long values for readability
      const truncated = table.samples.map(row => {
        const clean = {};
        for (const [k, v] of Object.entries(row)) {
          if (typeof v === 'string' && v.length > 120) {
            clean[k] = v.slice(0, 120) + '…';
          } else {
            clean[k] = v;
          }
        }
        return clean;
      });
      md += JSON.stringify(truncated, null, 2);
      md += '\n```\n\n</details>\n\n';
    }
  }

  return md;
}

// Load data-sources.json if present for richer descriptions
function loadDataSources() {
  for (const name of ['data-sources.json', 'data-sources.example.json']) {
    const p = join(dataDir, name);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8'));
      } catch { /* ignore */ }
    }
  }
  return null;
}

// Main
console.log(`📚 Building knowledge index for: ${workspace}`);

if (!existsSync(dataDir)) {
  console.error('No data/ directory found');
  process.exit(1);
}

const databases = findDatabases(dataDir);
console.log(`   Found ${databases.length} database(s)`);

const dataSources = loadDataSources();
const introspections = [];

for (const dbPath of databases) {
  try {
    const info = introspect(dbPath);
    introspections.push(info);
    const tableCount = info.tables.length;
    const rowCount = info.tables.reduce((sum, t) => sum + t.count, 0);
    console.log(`   ✓ ${info.path}: ${tableCount} table(s), ${rowCount.toLocaleString()} row(s)`);
  } catch (e) {
    console.error(`   ✗ ${relative(workspace, dbPath)}: ${e.message}`);
  }
}

// Build the output
let output = `# Schema Reference\n\n`;
output += `> Auto-generated by \`scripts/build-knowledge.js\` — do not edit manually.\n`;
output += `> Last built: ${new Date().toISOString().slice(0, 19)}Z\n\n`;

// Summary table
output += `## Databases\n\n`;
output += `| Database | Tables | Total Rows |\n`;
output += `|----------|--------|------------|\n`;
for (const info of introspections) {
  const tables = info.tables.length;
  const rows = info.tables.reduce((sum, t) => sum + t.count, 0);
  output += `| ${info.path} | ${tables} | ${rows.toLocaleString()} |\n`;
}
output += '\n';

// Data source mapping if available
if (dataSources?.sources) {
  output += `## Data Sources\n\n`;
  for (const [key, src] of Object.entries(dataSources.sources)) {
    output += `- **${src.name}** (\`${key}\`): \`${src.database}\``;
    if (src.sync_script) output += ` — sync: \`${src.sync_script}\``;
    output += '\n';
  }
  output += '\n';
}

// Detailed schemas
output += `## Detailed Schemas\n\n`;
for (const info of introspections) {
  output += formatDatabase(info);
}

// Write output
mkdirSync(knowledgeDir, { recursive: true });
const outputPath = join(knowledgeDir, 'schemas.md');
writeFileSync(outputPath, output);

console.log(`\n✅ Written to ${relative(workspace, outputPath)}`);
