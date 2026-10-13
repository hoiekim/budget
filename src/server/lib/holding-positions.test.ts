import { describe, expect, test } from "bun:test";
import {
  derivedSnapshotId,
  isUnchangedDerived,
  Movement,
  planHoldingPositions,
  StoredHoldingSnapshot,
} from "./holding-positions";

const tx = (date: string, type: string, quantity: number, amount: number, price: number) =>
  ({ date, type, quantity, amount, price }) as Movement;

const plan = (over: Partial<Parameters<typeof planHoldingPositions>[0]>) =>
  planHoldingPositions({
    account_id: "acct-1",
    security_id: "sec-1",
    movements: [],
    stored: [],
    throughMonth: "2027-01",
    replace: false,
    ...over,
  });

/** What the database holds after `writes` land, read back the way the engine reads it. */
const asStored = (writes: ReturnType<typeof planHoldingPositions>["writes"]): StoredHoldingSnapshot[] =>
  writes.map((w) => ({
    snapshot_id: w.snapshot_id,
    date: w.snapshot_date.slice(0, 10),
    quantity: Number(w.quantity!.toFixed(6)),
    cost_basis: Number(w.cost_basis!.toFixed(2)),
    institution_price: Number(w.institution_price!.toFixed(6)),
    institution_value: Number(w.institution_value!.toFixed(2)),
  }));

const entered = (date: string, quantity: number, over: Partial<StoredHoldingSnapshot> = {}): StoredHoldingSnapshot => ({
  snapshot_id: `holding-acct-1-sec-1-${date.replaceAll("-", "")}`,
  date,
  quantity,
  cost_basis: quantity * 3,
  institution_price: 48,
  institution_value: quantity * 48,
  ...over,
});

const quantities = (p: ReturnType<typeof planHoldingPositions>) =>
  p.writes.map((w) => [w.snapshot_date.slice(0, 10), Number(w.quantity!.toFixed(6))]);

const statement = [
  tx("2026-10-06", "buy", 10, 500, 50),
  tx("2026-11-03", "buy", 2, 104, 52),
  // Another writer's row, in a month the statement never touches.
  tx("2026-12-18", "buy", 0.5, 27, 54),
];

describe("planHoldingPositions", () => {
  test("a snapshot on each movement day and each month's 1st, under the derived prefix, at noon UTC", () => {
    const result = plan({ movements: statement });
    expect(result.gaps).toEqual([]);
    expect(quantities(result)).toEqual([
      ["2026-10-06", 10],
      ["2026-11-01", 10],
      ["2026-11-03", 12],
      ["2026-12-01", 12],
      ["2026-12-18", 12.5],
      ["2027-01-01", 12.5],
    ]);
    for (const w of result.writes) {
      expect(w.snapshot_id).toMatch(/^derived-holding-acct-1-sec-1-\d{8}-[0-9a-f]{12}$/);
      expect(w.snapshot_date.endsWith("T12:00:00Z")).toBe(true);
    }
    expect(result.writes[4]).toMatchObject({ cost_basis: 631, institution_price: 54, institution_value: 12.5 * 54 });
    expect(result.final).toEqual({ date: "2027-01-01", position: { quantity: 12.5, costBasis: 631, price: 54 } });
  });

  test("writes only what changed, and retires derived snapshots no longer produced", () => {
    const first = plan({ movements: statement });
    const stored = asStored(first.writes);
    expect(plan({ movements: statement, stored })).toMatchObject({ writes: [], retire: [] });

    // The November buy is gone: its day's snapshot retires and later figures move.
    const second = plan({ movements: [statement[0], statement[2]], stored });
    expect(second.retire.sort()).toEqual(
      stored.filter((s) => s.date >= "2026-11-03").map((s) => s.snapshot_id).sort(),
    );
    expect(quantities(second)).toEqual([
      ["2026-12-01", 10],
      ["2026-12-18", 10.5],
      ["2027-01-01", 10.5],
    ]);
  });

  test("figures that don't terminate still read back as the engine's own", () => {
    const awkward = [tx("2026-10-06", "buy", 100 / 3, 1000 / 7, 30 / 7), tx("2026-10-20", "sell", -1 / 9, -0.48, 4.32)];
    const first = plan({ movements: awkward, throughMonth: "2026-12" });
    const again = plan({ movements: awkward, stored: asStored(first.writes), throughMonth: "2026-12" });
    expect(again).toMatchObject({ writes: [], retire: [], gaps: [] });
  });

  test("sales draw on an entered position: fees and a withdrawal after 100 entered units", () => {
    const result = plan({
      stored: [entered("2026-01-02", 100)],
      movements: [
        tx("2026-02-27", "sell", -0.2, -9.6, 48),
        tx("2026-03-31", "sell", -0.2, -9.6, 48),
        tx("2026-05-15", "sell", -20, -960, 48),
      ],
      throughMonth: "2026-06",
    });
    expect(result.final!.position.quantity).toBeCloseTo(79.6, 6);
    expect(quantities(result)).toContainEqual(["2026-05-15", 79.6]);
  });

  test("a buy then a sale after an entered position, at the average cost of the whole position", () => {
    const result = plan({
      stored: [entered("2026-01-02", 100, { cost_basis: 300 })],
      movements: [tx("2026-02-01", "buy", 10, 500, 50), tx("2026-03-01", "sell", -30, -1500, 50)],
      throughMonth: "2026-03",
    });
    expect(result.final!.position.quantity).toBe(80);

    const costed = plan({
      stored: [entered("2026-01-02", 100, { cost_basis: 300 })],
      movements: [tx("2026-02-01", "buy", 10, 500, 50), tx("2026-03-01", "sell", -5, -250, 50)],
      throughMonth: "2026-03",
    });
    expect(costed.final!.position.costBasis).toBeCloseTo(800 - (800 / 110) * 5, 2);
  });

  test("each entered snapshot is a reset point", () => {
    const result = plan({
      stored: [entered("2026-01-02", 100), entered("2026-03-02", 50)],
      movements: [tx("2026-02-10", "buy", 10, 500, 50), tx("2026-04-10", "buy", 10, 500, 50)],
      throughMonth: "2026-04",
    });
    expect(result.final!.position.quantity).toBe(60);
    expect(result.gaps).toEqual([
      { date: "2026-01-02", stored: 100, explained: 0 },
      { date: "2026-03-02", stored: 50, explained: 110 },
    ]);
  });

  test("an entered snapshot is never rewritten, even with no price or cost of its own", () => {
    const bare = entered("2026-10-01", 100, { cost_basis: null, institution_price: null, institution_value: null });
    const result = plan({ movements: statement, stored: [bare] });
    expect(result.writes.some((w) => w.snapshot_date.startsWith("2026-10-01"))).toBe(false);
    expect(result.retire).toEqual([]);
    expect(result.final!.position.quantity).toBe(112.5);
  });

  test("months between an entered position and the first movement carry its price, not zero", () => {
    const result = plan({
      stored: [entered("2026-01-02", 100)],
      movements: [tx("2026-04-10", "buy", 10, 500, 50)],
      throughMonth: "2026-04",
    });
    const openings = result.writes.filter((w) => ["2026-02-01", "2026-03-01"].includes(w.snapshot_date.slice(0, 10)));
    expect(openings.map((w) => [w.quantity, w.institution_price])).toEqual([
      [100, 48],
      [100, 48],
    ]);
  });

  test("an edited derived snapshot counts as entered: kept, and the next movement applies on top", () => {
    const first = plan({ movements: statement });
    const stored = asStored(first.writes);
    const december = stored.find((s) => s.date === "2026-12-01")!;
    // Holding Detail keeps the id and changes the values.
    december.quantity = 15;
    december.institution_value = 15 * december.institution_price!;
    expect(isUnchangedDerived("acct-1", "sec-1", december)).toBe(false);

    const next = plan({ movements: [...statement, tx("2026-12-05", "buy", 1, 53, 53)], stored });
    expect(next.writes.some((w) => w.snapshot_date.startsWith("2026-12-01"))).toBe(false);
    expect(next.retire).not.toContain(december.snapshot_id);
    expect(next.gaps).toEqual([{ date: "2026-12-01", stored: 15, explained: 12 }]);
    expect(next.final!.position.quantity).toBe(16.5);
  });

  test("replace ignores and retires entered snapshots", () => {
    const own = entered("2026-10-01", 100);
    const result = plan({ movements: statement, stored: [own], replace: true });
    expect(result.gaps).toEqual([{ date: "2026-10-01", stored: 100, explained: 0 }]);
    expect(result.retire).toEqual([own.snapshot_id]);
    expect(result.final!.position.quantity).toBe(12.5);
  });

  test("a derived snapshot another run wrote on a day no longer produced is retired, not read as entered", () => {
    const stale = asStored(
      plan({ movements: statement.slice(0, 2), throughMonth: "2026-11" }).writes.filter((w) => w.snapshot_date.startsWith("2026-11-03")),
    );
    // A later movement dated before it changes what that day should read.
    const result = plan({ movements: [...statement, tx("2026-10-20", "buy", 5, 255, 51)], stored: stale });
    expect(result.gaps).toEqual([]);
    expect(result.retire).toEqual([stale[0].snapshot_id]);
    expect(quantities(result)).toContainEqual(["2026-11-03", 17]);
  });
});

describe("derivedSnapshotId", () => {
  test("the id changes with every stored value", () => {
    const base = { quantity: 10, costBasis: 500, price: 50 };
    const id = derivedSnapshotId("a", "s", "2026-10-06", base);
    expect(derivedSnapshotId("a", "s", "2026-10-07", base)).not.toBe(id);
    expect(derivedSnapshotId("a", "s", "2026-10-06", { ...base, quantity: 10.000001 })).not.toBe(id);
    expect(derivedSnapshotId("a", "s", "2026-10-06", { ...base, costBasis: 500.01 })).not.toBe(id);
    expect(derivedSnapshotId("a", "s", "2026-10-06", { ...base, price: 50.000001 })).not.toBe(id);
    expect(derivedSnapshotId("a", "other", "2026-10-06", base)).not.toBe(id);
  });
});
