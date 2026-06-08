import { pool } from "./client";
import { logger } from "../logger";

/**
 * One-time cleanup that collapses duplicate `active_from` rows in every
 * `budgets.capacities` / `sections.capacities` / `categories.capacities`
 * array, keeping the FIRST occurrence in array order.
 *
 * Why dedupe is necessary:
 *   `BudgetFamily.getActiveCapacity(date)` picks the first
 *   `active_from <= date` row from a stable-sorted-desc copy. For two
 *   rows with the same `active_from`, the first in the array wins on
 *   display. The duplicates are unreachable but still persist to disk
 *   and pollute every server-side `JSON.parse(capacities).map(...)`
 *   that touches them.
 *
 * Why FIRST not LAST:
 *   The first-in-array row is the one the user is currently seeing in
 *   the UI. Picking any other element silently swaps the displayed
 *   value to one the user never saw.
 *
 * Idempotent: skips rows that are already deduplicated. Runs on every
 * startup; once the data is clean the SELECT in the WHERE clause is
 * empty and the UPDATE is a no-op.
 */
export const cleanupDuplicateCapacityRows = async (): Promise<void> => {
  const targets: Array<{ table: string; idCol: string }> = [
    { table: "budgets", idCol: "budget_id" },
    { table: "sections", idCol: "section_id" },
    { table: "categories", idCol: "category_id" },
  ];
  for (const { table, idCol } of targets) {
    const result = await pool.query(
      `
      UPDATE ${table} SET capacities = (
        SELECT jsonb_agg(c)
        FROM (
          SELECT DISTINCT ON (COALESCE(e.value->>'active_from', '__NULL__')) e.value AS c
          FROM jsonb_array_elements(capacities) WITH ORDINALITY AS e(value, ord)
          ORDER BY COALESCE(e.value->>'active_from', '__NULL__'), e.ord ASC
        ) sub
      )
      WHERE ${idCol} IN (
        SELECT t.${idCol} FROM ${table} t, jsonb_array_elements(t.capacities) e
        GROUP BY t.${idCol}, e.value->>'active_from'
        HAVING COUNT(*) > 1
      )
      `,
    );
    const collapsed = result.rowCount ?? 0;
    if (collapsed > 0) {
      logger.info(`cleanup-capacity-duplicates: collapsed duplicates in ${collapsed} ${table} rows`);
    }
  }
};
