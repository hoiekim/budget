import { JSONCapacity } from "../models/BudgetFamily";

/**
 * Collapse duplicate-`active_from` rows in a capacities array, keeping the
 * FIRST occurrence in input order.
 *
 * Why "first": `BudgetFamily.getActiveCapacity(date)` sorts capacities by
 * `active_from` DESC (stable in V8) and returns the first row matching
 * `active_from <= date`. For two rows with the same `active_from`, the
 * first in the input array wins on display — so dedupe by keeping the
 * first preserves the value the user is currently seeing.
 *
 * `active_from = undefined` / `null` is the "all past" bucket and is
 * collapsed with other `undefined`/`null` rows. Empty (no capacities)
 * input passes through unchanged.
 *
 * Pure / non-mutating. Returns a new array.
 */
export const dedupeCapacities = (capacities: JSONCapacity[]): JSONCapacity[] => {
  if (!capacities || capacities.length <= 1) return capacities;
  const seen = new Set<string>();
  const result: JSONCapacity[] = [];
  for (const cap of capacities) {
    const key = cap.active_from ? new Date(cap.active_from).getTime().toString() : "__NULL__";
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cap);
  }
  return result;
};
