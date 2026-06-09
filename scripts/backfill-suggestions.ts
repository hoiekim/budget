/**
 * One-time backfill from the legacy `transactions.label_*` denorm columns
 * into the new `suggestions` table (introduced by PR #496).
 *
 * Intentionally NOT wired into `initializePostgres` — Hoie's call: one-time
 * migrations should run separately, manually, so a production deploy doesn't
 * silently mass-write rows on every container start.
 *
 * Idempotent via `ON CONFLICT (transaction_id, category_id) DO NOTHING`,
 * so a re-run after a partial completion is safe (it just skips rows
 * that were already inserted).
 *
 * Run once after the PR #496 schema is in place:
 *
 *     bun scripts/backfill-suggestions.ts
 *
 * Inspects the rowcount on the way out. Exits non-zero on any pool error.
 */

import { pool } from "../src/server/lib/postgres/client";
import { backfillSuggestionsFromLegacyColumns } from "../src/server/lib/postgres/backfill-suggestions";

const main = async (): Promise<void> => {
  try {
    await backfillSuggestionsFromLegacyColumns();
    const result = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::TEXT AS n FROM suggestions`,
    );
    console.log(`suggestions table now holds ${result.rows[0].n} rows`);
  } finally {
    await pool.end();
  }
};

main().catch((err) => {
  console.error("backfill-suggestions failed:", err);
  process.exit(1);
});
