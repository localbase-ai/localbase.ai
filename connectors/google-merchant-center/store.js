/**
 * Writing Merchant Center data into SQLite. Kept apart from sync.js so the
 * snapshot rules can be tested without the network.
 */
import { ALL_DDL } from './reports.js';

export function initDb(db) {
  db.pragma('journal_mode = WAL');
  for (const ddl of ALL_DDL) db.exec(ddl);
  return db;
}

/** Upsert keyed on the table's primary key; `keep` columns are never overwritten. */
export function makeUpsert(db, table, sampleRow, { keep = [] } = {}) {
  const cols = Object.keys(sampleRow);
  const pk = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.pk).map((c) => c.name);
  const updatable = cols.filter((c) => !pk.includes(c) && !keep.includes(c));
  return db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
     ON CONFLICT(${pk.join(', ')}) DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(', ')}`
  );
}

/**
 * Replace one account's product snapshot.
 *
 * Only call this with the COMPLETE catalogue from a finished pull: a product
 * absent from `rows` is stamped disappeared, so a partial list would mark
 * real products gone. Children (destinations, issues) are replaced wholesale.
 * A product that reappears has `disappeared_at` cleared.
 */
export function writeProductSnapshot(db, accountId, rows, seenAt) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM mc_product_destinations WHERE account_id = ?').run(accountId);
    db.prepare('DELETE FROM mc_product_issues WHERE account_id = ?').run(accountId);
    if (rows.length) {
      const upProduct = makeUpsert(db, 'mc_products', rows[0].product, { keep: ['first_seen_at'] });
      const allDest = rows.flatMap((r) => r.destinations);
      const allIssues = rows.flatMap((r) => r.issues);
      const upDest = allDest.length ? makeUpsert(db, 'mc_product_destinations', allDest[0]) : null;
      const issueCols = allIssues.length ? Object.keys(allIssues[0]) : [];
      const insIssue = allIssues.length
        ? db.prepare(`INSERT INTO mc_product_issues (${issueCols.join(', ')})
                      VALUES (${issueCols.map((c) => `@${c}`).join(', ')})`)
        : null;
      for (const r of rows) upProduct.run(r.product);
      for (const d of allDest) upDest.run(d);
      for (const i of allIssues) insIssue.run(i);
    }
    const gone = db.prepare(`UPDATE mc_products SET disappeared_at = ?
      WHERE account_id = ? AND last_seen_at < ? AND disappeared_at IS NULL`).run(seenAt, accountId, seenAt);
    return gone.changes;
  });
  return tx();
}

export function writeRows(db, table, rows) {
  if (!rows.length) return 0;
  const up = makeUpsert(db, table, rows[0]);
  db.transaction((batch) => batch.forEach((r) => up.run(r)))(rows);
  return rows.length;
}

/** Account issues are a snapshot too; replace them per account. */
export function writeAccountIssues(db, accountId, rows) {
  db.transaction(() => {
    db.prepare('DELETE FROM mc_account_issues WHERE account_id = ?').run(accountId);
    if (rows.length) writeRows(db, 'mc_account_issues', rows);
  })();
  return rows.length;
}

export function getWatermark(db, accountId, report) {
  return db.prepare('SELECT watermark_date FROM sync_state WHERE account_id = ? AND report = ?')
    .get(accountId, report)?.watermark_date ?? null;
}

export function setWatermark(db, accountId, report, date, rowCount) {
  db.prepare(`INSERT INTO sync_state (account_id, report, watermark_date, last_run_at, last_row_count)
              VALUES (@accountId, @report, @date, @now, @count)
              ON CONFLICT(account_id, report) DO UPDATE SET
                watermark_date = excluded.watermark_date,
                last_run_at = excluded.last_run_at,
                last_row_count = excluded.last_row_count`)
    .run({ accountId, report, date, now: new Date().toISOString(), count: rowCount });
}
