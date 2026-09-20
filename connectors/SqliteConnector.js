/**
 * Base class for connectors that expose an already-synced SQLite database.
 *
 * Two shapes of connector have grown up in this repo. API-backed ones (see
 * `connectors/quickbooks/`) call the vendor on every tool call, which costs
 * rate-limit budget, needs live credentials, and fails when the vendor is down.
 * DB-backed ones read the local file a scheduled sync already produced: instant,
 * free, offline, and reproducible. Where a connector syncs on a schedule, the
 * DB-backed shape is the better default, and this class is the whole of it.
 *
 * Subclasses supply a name, a tool prefix and a path; they get three tools:
 *
 *   <prefix>_query        read-only SQL over the synced tables
 *   <prefix>_schema       tables, row counts and columns
 *   <prefix>_sync_status  whatever the connector records in sync_state
 *
 * `sync_status` deliberately does `SELECT *`. Every connector here keeps a
 * `sync_state` table and no two agree on its columns — property/report,
 * site/report/search_type, location_id, site_id, entity/watermark — so naming
 * them would break on the next connector rather than the next schema change.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { BaseConnector } from './MCPAdapter.js';

export class SqliteConnector extends BaseConnector {
  /**
   * @param {object} opts
   * @param {string} opts.name     connector id, e.g. 'google-analytics'
   * @param {string} opts.prefix   tool-name prefix, e.g. 'ga'
   * @param {string} opts.dbPath   absolute path to the synced database
   * @param {string} opts.label    human name used in tool descriptions
   * @param {string} [opts.syncHint] command that rebuilds the database
   * @param {string} [opts.notes]  extra sentence appended to the query tool description
   */
  constructor({ name, prefix, dbPath, label, syncHint, notes }) {
    super(name);
    this.prefix = prefix;
    this.dbPath = dbPath;
    this.label = label;
    this.syncHint = syncHint ?? `node connectors/${name}/sync.js`;
    this.notes = notes ?? '';
  }

  openDb() {
    if (!existsSync(this.dbPath)) {
      throw new Error(`No ${this.label} database yet. Run: ${this.syncHint}`);
    }
    return new Database(this.dbPath, { readonly: true });
  }

  /** Real tables only — sqlite internals and FTS shadow tables are noise here. */
  tables(db) {
    return db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .all()
      .map((r) => r.name);
  }

  async getTools() {
    let tableList = '';
    try {
      const db = this.openDb();
      try { tableList = ` Tables: ${this.tables(db).join(', ')}.`; } finally { db.close(); }
    } catch {
      // Listing tools must not require the database to exist yet — an unsynced
      // connector should still advertise its tools and explain itself on call.
    }

    return [
      {
        name: `${this.prefix}_query`,
        description:
          `Run a read-only SQL query against the synced ${this.label} database.${tableList} `
          + `Reads the local file, so it is instant and costs no API quota.${this.notes ? ' ' + this.notes : ''}`,
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'A single SELECT statement' },
            params: { type: 'array', description: 'Positional bind parameters', items: {} },
          },
          required: ['sql'],
        },
      },
      {
        name: `${this.prefix}_schema`,
        description: `List the synced ${this.label} tables with their columns and row counts.`,
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: `${this.prefix}_sync_status`,
        description: `Show what ${this.label} last synced and when.`,
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async canHandleTool(toolName) {
    return toolName.startsWith(`${this.prefix}_`);
  }

  async handleTool(toolName, args = {}) {
    try {
      switch (toolName) {
        case `${this.prefix}_query`:
          return this.formatResponse(this.query(args.sql, args.params ?? []));
        case `${this.prefix}_schema`:
          return this.formatResponse(this.describe());
        case `${this.prefix}_sync_status`:
          return this.formatResponse(this.syncStatus());
        default:
          return this.formatError(new Error(`Unknown tool: ${toolName}`));
      }
    } catch (error) {
      return this.formatError(error);
    }
  }

  /** Read-only by construction: the connection is readonly and DDL/DML is rejected. */
  query(sql, params = []) {
    if (typeof sql !== 'string' || !sql.trim()) throw new Error('sql is required');
    const normalized = sql.trim().replace(/^\s*--.*$/gm, '').trim();
    if (!/^(select|with)\b/i.test(normalized)) {
      throw new Error('Only SELECT (or WITH ... SELECT) queries are allowed');
    }
    if (/;\s*\S/.test(normalized)) {
      throw new Error('Only a single statement is allowed');
    }

    const db = this.openDb();
    try {
      return db.prepare(normalized).all(...params);
    } finally {
      db.close();
    }
  }

  describe() {
    const db = this.openDb();
    try {
      return this.tables(db).map((table) => {
        const columns = db
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((c) => `${c.name} ${c.type}`);
        const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
        return { table, rows: n, columns };
      });
    } finally {
      db.close();
    }
  }

  syncStatus() {
    const db = this.openDb();
    try {
      if (!this.tables(db).includes('sync_state')) {
        return { note: `${this.label} does not record a sync_state table.` };
      }
      return db.prepare('SELECT * FROM sync_state').all();
    } finally {
      db.close();
    }
  }
}

export default SqliteConnector;
