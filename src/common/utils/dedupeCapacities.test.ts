import { describe, expect, test } from "bun:test";
import { dedupeCapacities } from "./dedupeCapacities";
import type { JSONCapacity } from "../models/BudgetFamily";

const cap = (active_from?: Date | null, month = 0) =>
  ({ capacity_id: "x", active_from, month, year: month * 12, isInfinite: false, isIncome: false }) as unknown as JSONCapacity;

describe("dedupeCapacities", () => {
  test("passes through empty / single-row arrays unchanged", () => {
    expect(dedupeCapacities([])).toEqual([]);
    const one = [cap(new Date("2026-07-01"), 100)];
    expect(dedupeCapacities(one)).toBe(one);
  });

  test("keeps first occurrence in input order when active_from is the same", () => {
    const a = cap(new Date("2026-07-01"), 100);
    const b = cap(new Date("2026-07-01"), 200);
    const result = dedupeCapacities([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(a);
    expect(result[0].month).toBe(100);
  });

  test("collapses multiple NULL/undefined active_from rows into one", () => {
    const a = cap(undefined, 100);
    const b = cap(null, 200);
    const c = cap(undefined, 300);
    const result = dedupeCapacities([a, b, c]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(a);
  });

  test("preserves distinct active_from rows", () => {
    const jul = cap(new Date("2026-07-01"), 1);
    const aug = cap(new Date("2026-08-01"), 2);
    const sep = cap(new Date("2026-09-01"), 3);
    expect(dedupeCapacities([jul, aug, sep])).toHaveLength(3);
  });

  test("collapses Date-instance vs string equivalence", () => {
    const a = cap(new Date("2026-07-01T00:00:00.000Z"), 10);
    const b = { ...cap(undefined, 20), active_from: "2026-07-01T00:00:00.000Z" } as unknown as JSONCapacity;
    const result = dedupeCapacities([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(a);
  });

  test("non-mutating — input array is unchanged", () => {
    const a = cap(undefined, 1);
    const b = cap(undefined, 2);
    const input = [a, b];
    const copy = [...input];
    dedupeCapacities(input);
    expect(input).toEqual(copy);
  });

  test("mixed: NULL + distinct dates + duplicates", () => {
    const n1 = cap(undefined, 0);
    const n2 = cap(undefined, 99);
    const jul1 = cap(new Date("2026-07-01"), 1);
    const jul2 = cap(new Date("2026-07-01"), 2);
    const aug = cap(new Date("2026-08-01"), 3);
    const result = dedupeCapacities([n1, jul1, n2, aug, jul2]);
    expect(result).toHaveLength(3); // NULL, Jul, Aug
    expect(result[0]).toBe(n1);
    expect(result[1]).toBe(jul1);
    expect(result[2]).toBe(aug);
  });
});
