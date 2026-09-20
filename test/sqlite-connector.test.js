/**
 * SqliteConnector tests
 *
 * The base class every DB-backed connector inherits. The read-only guarantee
 * is the part worth defending: these tools are the surface an MCP client gets,
 * and a client is free to send whatever SQL it likes.
 *
 * Run with: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { SqliteConnector } from '../connectors/SqliteConnector.js';

let dir, dbPath, connector;

class TestConnector extends SqliteConnector {
  constructor(path) {
    super({ name: 'test-source', prefix: 'tst', label: 'Test Source', dbPath: path });
  }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlite-connector-'));
  dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER);
    INSERT INTO widgets (name, qty) VALUES ('alpha', 3), ('beta', 5);
    CREATE TABLE sync_state (source TEXT, watermark TEXT, last_run_at TEXT);
    INSERT INTO sync_state VALUES ('widgets', '2026-09-19', '2026-09-19T12:00:00Z');
  `);
  db.close();
  connector = new TestConnector(dbPath);
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe('SqliteConnector', () => {
  it('exposes query, schema and sync_status under its prefix', async () => {
    const names = (await connector.getTools()).map((t) => t.name);
    assert.deepEqual(names, ['tst_query', 'tst_schema', 'tst_sync_status']);
  });

  it('claims only its own prefix', async () => {
    assert.equal(await connector.canHandleTool('tst_query'), true);
    assert.equal(await connector.canHandleTool('other_query'), false);
  });

  it('runs a SELECT', () => {
    assert.deepEqual(connector.query('SELECT name, qty FROM widgets ORDER BY name'),
      [{ name: 'alpha', qty: 3 }, { name: 'beta', qty: 5 }]);
  });

  it('binds positional parameters rather than interpolating', () => {
    assert.deepEqual(connector.query('SELECT name FROM widgets WHERE qty > ?', [4]),
      [{ name: 'beta' }]);
  });

  it('allows a WITH ... SELECT', () => {
    assert.deepEqual(connector.query('WITH t AS (SELECT qty FROM widgets) SELECT SUM(qty) s FROM t'),
      [{ s: 8 }]);
  });

  for (const sql of [
    'DROP TABLE widgets',
    'DELETE FROM widgets',
    'UPDATE widgets SET qty = 0',
    'INSERT INTO widgets (name, qty) VALUES ("x", 1)',
    'PRAGMA writable_schema = 1',
    'ATTACH DATABASE \'/tmp/evil.db\' AS evil',
  ]) {
    it(`rejects: ${sql.slice(0, 32)}`, () => {
      assert.throws(() => connector.query(sql), /Only SELECT/);
    });
  }

  it('rejects a second statement smuggled after a SELECT', () => {
    assert.throws(() => connector.query('SELECT 1; DROP TABLE widgets'), /single statement/);
  });

  it('rejects a write hidden behind a leading comment', () => {
    assert.throws(() => connector.query('-- harmless\nDELETE FROM widgets'), /Only SELECT/);
  });

  it('rejects empty sql', () => {
    assert.throws(() => connector.query('   '), /sql is required/);
  });

  it('the connection itself is read-only, not just the guard', () => {
    const db = connector.openDb();
    try {
      assert.throws(() => db.prepare('DELETE FROM widgets').run(), /readonly/i);
    } finally {
      db.close();
    }
  });

  it('describes tables with row counts and columns', () => {
    const widgets = connector.describe().find((t) => t.table === 'widgets');
    assert.equal(widgets.rows, 2);
    assert.ok(widgets.columns.some((c) => c.startsWith('qty ')));
  });

  it('reads sync_state without assuming its columns', () => {
    assert.deepEqual(connector.syncStatus(),
      [{ source: 'widgets', watermark: '2026-09-19', last_run_at: '2026-09-19T12:00:00Z' }]);
  });

  it('still lists its tools when the database does not exist yet', async () => {
    const missing = new TestConnector(join(dir, 'nope.db'));
    assert.equal((await missing.getTools()).length, 3);
    const res = await missing.handleTool('tst_query', { sql: 'SELECT 1' });
    assert.match(res.content[0].text, /No Test Source database yet/);
  });

  it('returns errors as tool results rather than throwing at the server', async () => {
    const res = await connector.handleTool('tst_query', { sql: 'DROP TABLE widgets' });
    assert.match(res.content[0].text, /Only SELECT/);
  });
});
