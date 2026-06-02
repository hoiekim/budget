import { test, expect, afterEach, describe } from "bun:test";
import { MAX_FLOAT } from "common";
import { Capacity, type CapacityChildLike } from "./Capacity";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const originalRandomUUID = globalThis.crypto?.randomUUID;
const originalGetRandomValues = globalThis.crypto?.getRandomValues;

afterEach(() => {
  if (!globalThis.crypto) return;
  if (originalRandomUUID) {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: originalRandomUUID,
      configurable: true,
      writable: true,
    });
  }
  if (originalGetRandomValues) {
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      value: originalGetRandomValues,
      configurable: true,
      writable: true,
    });
  }
});

test("Capacity assigns a v4 UUID when crypto.randomUUID is available", () => {
  const c = new Capacity();
  expect(c.capacity_id).toMatch(UUID_V4_RE);
});

test("Capacity preserves an explicitly provided capacity_id", () => {
  const c = new Capacity({ capacity_id: "preset-id" });
  expect(c.capacity_id).toBe("preset-id");
});

test("Capacity falls back to manual UUID v4 when crypto.randomUUID is missing (issue #320)", () => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  const c = new Capacity();
  expect(c.capacity_id).toMatch(UUID_V4_RE);
});

test("Capacity falls back to Math.random when both randomUUID and getRandomValues are missing", () => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  const c = new Capacity();
  expect(c.capacity_id).toMatch(UUID_V4_RE);
});

// ─────────────────────────────────────────────────────────────────────────
// Capacity.getActiveAmount
// ─────────────────────────────────────────────────────────────────────────
//
// Contract:
//  - is_synced = false (default) → return stored this[interval]
//  - is_synced = true →  sum children's getActiveAmount at the same period
//    - no children → 0
//    - any infinite child poisons the sum to ±MAX_FLOAT (sign follows the
//      offending child)
//    - children's period resolution uses each child.getActiveCapacity at
//      this capacity's active_from (or new Date(0) when undefined)
//    - synced children themselves recurse — grandchildren reach through
//  - tests build a minimal stub of CapacityChildLike rather than depending
//    on BudgetFamily so the unit is genuinely a unit.

// Helper: build a child whose active capacities are fixed by date-range.
// `capacities` is the child's own capacities (sorted desc by active_from).
// `children` is the child's children (recursive).
const buildChild = (
  capacities: Capacity[],
  children: CapacityChildLike[] = [],
): CapacityChildLike => ({
  getActiveCapacity: (date: Date) => {
    const sorted = [...capacities].sort((a, b) => {
      const A = a.active_from?.getTime() ?? -Infinity;
      const B = b.active_from?.getTime() ?? -Infinity;
      return B - A;
    });
    return sorted.find((c) => (c.active_from?.getTime() ?? 0) <= date.getTime());
  },
  getChildren: () => children,
});

describe("Capacity.getActiveAmount", () => {
  // For tests that don't care about the period, use epoch as a stable date.
  const EPOCH = new Date(0);

  test("is_synced=false returns stored month/year directly", () => {
    const c = new Capacity({ month: 123 });
    expect(c.getActiveAmount(EPOCH, "month")).toBe(123);
    expect(c.getActiveAmount(EPOCH, "year")).toBe(123 * 12);
  });

  test("is_synced=false ignores children even when provided", () => {
    const c = new Capacity({ month: 50 });
    const noisyChild = buildChild([new Capacity({ month: 9999 })]);
    expect(c.getActiveAmount(EPOCH, "month", [noisyChild])).toBe(50);
  });

  test("is_synced=true with no children returns 0 (empty sum)", () => {
    const c = new Capacity({ is_synced: true, month: 99 });
    expect(c.getActiveAmount(EPOCH, "month")).toBe(0);
    expect(c.getActiveAmount(EPOCH, "month", [])).toBe(0);
  });

  test("is_synced=true ignores the stored month cache, uses derived sum", () => {
    // Stored month = 9999 (stale cache); children sum to 30 → derived = 30.
    const c = new Capacity({ is_synced: true, month: 9999 });
    const child = buildChild([new Capacity({ month: 30 })]);
    expect(c.getActiveAmount(EPOCH, "month", [child])).toBe(30);
  });

  test("is_synced=true sums multiple non-synced children", () => {
    const c = new Capacity({ is_synced: true });
    const children = [10, 20, 30].map((m) => buildChild([new Capacity({ month: m })]));
    expect(c.getActiveAmount(EPOCH, "month", children)).toBe(60);
  });

  test("is_synced=true recurses through a synced child to its grandchildren", () => {
    const c = new Capacity({ is_synced: true });
    const grandChildren = [11, 22, 33].map((m) => buildChild([new Capacity({ month: m })]));
    const syncedChild = buildChild([new Capacity({ is_synced: true })], grandChildren);
    expect(c.getActiveAmount(EPOCH, "month", [syncedChild])).toBe(66);
  });

  test("is_synced=true with a synced child that has no grandchildren contributes 0", () => {
    const c = new Capacity({ is_synced: true });
    const emptySyncedChild = buildChild([new Capacity({ is_synced: true })], []);
    const concreteChild = buildChild([new Capacity({ month: 50 })]);
    expect(c.getActiveAmount(EPOCH, "month", [emptySyncedChild, concreteChild])).toBe(50);
  });

  test("is_synced=true poisons to +MAX_FLOAT when a child is positive-infinite", () => {
    const c = new Capacity({ is_synced: true });
    const finite = buildChild([new Capacity({ month: 100 })]);
    const infinite = buildChild([new Capacity({ month: MAX_FLOAT })]);
    expect(c.getActiveAmount(EPOCH, "month", [finite, infinite])).toBe(MAX_FLOAT);
  });

  test("is_synced=true poisons to -MAX_FLOAT when a child is negative-infinite", () => {
    const c = new Capacity({ is_synced: true });
    const finite = buildChild([new Capacity({ month: 100 })]);
    const infinite = buildChild([new Capacity({ month: -MAX_FLOAT })]);
    expect(c.getActiveAmount(EPOCH, "month", [finite, infinite])).toBe(-MAX_FLOAT);
  });

  test("is_synced=true with all-zero children returns 0", () => {
    const c = new Capacity({ is_synced: true });
    const children = [new Capacity({ month: 0 }), new Capacity({ month: 0 })].map((cap) =>
      buildChild([cap]),
    );
    expect(c.getActiveAmount(EPOCH, "month", children)).toBe(0);
  });

  test("is_synced=true mixes positive + negative finite children with arithmetic sum", () => {
    const c = new Capacity({ is_synced: true });
    const children = [50, -20, 7].map((m) => buildChild([new Capacity({ month: m })]));
    expect(c.getActiveAmount(EPOCH, "month", children)).toBe(37);
  });

  test("queries children at the caller-supplied date (not the parent's active_from)", () => {
    // Parent capacity active_from=2024-01 (lives "from" then onward) but
    // the user is viewing 2025-06. Child has two capacities: one at
    // 2024-01 ($100) and one at 2025-01 ($500). The view-date is what
    // selects which child capacity is active — at 2025-06 the child's
    // 2025-01 capacity applies, so the derived sum is $500.
    const parent = new Capacity({
      is_synced: true,
      active_from: new Date("2024-01-01T00:00:00Z"),
    });
    const child = buildChild([
      new Capacity({ month: 100, active_from: new Date("2024-01-01T00:00:00Z") }),
      new Capacity({ month: 500, active_from: new Date("2025-01-01T00:00:00Z") }),
    ]);
    expect(parent.getActiveAmount(new Date("2025-06-01T00:00:00Z"), "month", [child])).toBe(500);
    // Sanity: same parent at 2024-06 returns the earlier child capacity.
    expect(parent.getActiveAmount(new Date("2024-06-01T00:00:00Z"), "month", [child])).toBe(100);
  });

  test("does NOT use this.active_from for child resolution (regression for the view-date bug)", () => {
    // The pre-fix bug: getActiveAmount silently used this.active_from to
    // query children. Here the parent's active_from is in 2024 but the
    // caller asks for 2025. The 2024 child capacity must NOT win.
    const parent = new Capacity({
      is_synced: true,
      active_from: new Date("2024-01-01T00:00:00Z"),
    });
    const child = buildChild([
      new Capacity({ month: 1, active_from: new Date("2024-01-01T00:00:00Z") }),
      new Capacity({ month: 99, active_from: new Date("2025-01-01T00:00:00Z") }),
    ]);
    const got = parent.getActiveAmount(new Date("2025-06-01T00:00:00Z"), "month", [child]);
    // If the bug regresses, `got` would be 1 (child capacity selected at
    // parent.active_from=2024-01). With the fix, it's 99.
    expect(got).toBe(99);
  });

  test("child has no capacity for the requested date → contributes 0", () => {
    // Child has only a 2025 capacity; viewing 2020 — no capacity applies,
    // child contributes nothing.
    const childWith2025Only = buildChild([
      new Capacity({ month: 500, active_from: new Date("2025-01-01T00:00:00Z") }),
    ]);
    const childAlwaysActive = buildChild([new Capacity({ month: 10 })]);
    const parent = new Capacity({ is_synced: true });
    expect(
      parent.getActiveAmount(new Date("2020-01-01T00:00:00Z"), "month", [
        childWith2025Only,
        childAlwaysActive,
      ]),
    ).toBe(10);
  });

  test("year interval scales children correctly via Capacity.year getter", () => {
    const parent = new Capacity({ is_synced: true });
    const children = [10, 20].map((m) => buildChild([new Capacity({ month: m })]));
    expect(parent.getActiveAmount(EPOCH, "year", children)).toBe(360); // (10 + 20) * 12
  });

  test("NaN children are skipped (defensive — one corrupted row doesn't blackhole the sum)", () => {
    const parent = new Capacity({ is_synced: true });
    const sane = buildChild([new Capacity({ month: 50 })]);
    const corrupted = buildChild([new Capacity({ month: NaN })]);
    expect(parent.getActiveAmount(EPOCH, "month", [sane, corrupted])).toBe(50);
  });

  test("does not mutate the parent or children during resolution", () => {
    const parent = new Capacity({ is_synced: true, month: 42 });
    const childCap = new Capacity({ month: 10 });
    const child = buildChild([childCap]);
    const parentBefore = JSON.stringify(parent.toJSON());
    const childBefore = JSON.stringify(childCap.toJSON());
    parent.getActiveAmount(EPOCH, "month", [child]);
    expect(JSON.stringify(parent.toJSON())).toBe(parentBefore);
    expect(JSON.stringify(childCap.toJSON())).toBe(childBefore);
  });

  test("is_synced=true round-trips through toJSON/new Capacity()", () => {
    const original = new Capacity({ is_synced: true, month: 0 });
    const json = original.toJSON();
    expect(json.is_synced).toBe(true);
    const restored = new Capacity(json);
    expect(restored.is_synced).toBe(true);
    expect(restored.getActiveAmount(EPOCH, "month", [])).toBe(0);
  });

  test("is_synced defaults to false when not provided in JSON", () => {
    const fromBareJSON = new Capacity({ capacity_id: "x", month: 12 });
    expect(fromBareJSON.is_synced).toBe(false);
    expect(fromBareJSON.getActiveAmount(EPOCH, "month")).toBe(12);
  });

  test("is_synced=true at the leaf returns 0 even if the leaf has a stored month — never reads cache when synced", () => {
    // Defensive: a leaf shouldn't normally be is_synced, but if a buggy
    // caller flips a category to is_synced, the displayed amount becomes 0
    // rather than silently emitting the stored (possibly stale) value.
    const leaf = new Capacity({ is_synced: true, month: 9999 });
    expect(leaf.getActiveAmount(EPOCH, "month", [])).toBe(0);
  });
});
