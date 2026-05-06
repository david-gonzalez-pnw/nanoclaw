/**
 * scripts/q.ts — sqlite3 CLI replacement for skill SQL invocations.
 *
 * Usage:
 *   pnpm exec tsx scripts/q.ts <db-path> "<sql>"
 *
 * Detects SELECT vs mutation on the first keyword. SELECT/WITH queries
 * print rows in sqlite3 CLI default ("list") format — pipe-separated,
 * no header — so existing skill text reads identically. Anything else
 * runs through db.exec() and prints nothing on success.
 *
 * Why this exists: setup/verify.ts:5 codifies that NanoClaw avoids
 * depending on the sqlite3 CLI binary; setup never installs or probes
 * for it. Skills that shell out to `sqlite3` therefore fail on hosts
 * where it isn't preinstalled (common on fresh Ubuntu — see #2191).
 * This wrapper preserves the skill-text shape (path then SQL string)
 * while routing through the better-sqlite3 dep that setup already
 * installs and verifies.
 */
import Database from 'better-sqlite3';

const [, , dbPath, sql] = process.argv;

if (!dbPath || sql === undefined) {
  console.error('Usage: pnpm exec tsx scripts/q.ts <db-path> "<sql>"');
  process.exit(2);
}

const db = new Database(dbPath);
try {
  const firstKeyword = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  if (firstKeyword === 'SELECT' || firstKeyword === 'WITH') {
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    for (const row of rows) {
      console.log(
        Object.values(row)
          .map((v) => (v === null ? '' : String(v)))
          .join('|'),
      );
    }
  } else {
    db.exec(sql);
  }
} finally {
  db.close();
}
