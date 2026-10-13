import { describe, expect, test } from "bun:test";
import {
  derivedSnapshotId,
  enteredResetPoints,
  isEnteredSnapshot,
  isUnchangedDerived,
  positionBefore,
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

/** Rounds the way Postgres `numeric(p, s)` does: half away from zero, on the decimal digits. */
const pgRound = (n: number, scale: number) => {
  const [whole, fraction = ""] = Math.abs(n).toString().split(".");
  const digits = (fraction + "0".repeat(scale + 1)).slice(0, scale + 1);
  let scaled = BigInt(whole + digits.slice(0, scale));
  if (Number(digits[scale]) >= 5) scaled += 1n;
  return (Math.sign(n) || 1) * Number(scaled) / 10 ** scale;
};

/** What the database holds after `writes` land, read back the way the engine reads it. */
const asStored = (writes: ReturnType<typeof planHoldingPositions>["writes"]): StoredHoldingSnapshot[] =>
  writes.map((w) => ({
    snapshot_id: w.snapshot_id,
    date: w.snapshot_date.slice(0, 10),
    quantity: pgRound(w.quantity!, 6),
    cost_basis: w.cost_basis === null || w.cost_basis === undefined ? null : pgRound(w.cost_basis, 2),
    institution_price: pgRound(w.institution_price!, 6),
    institution_value: pgRound(w.institution_value!, 2),
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

describe("planHoldingPositions, round 4", () => {
  test("a derived snapshot moved to another date stays where it was moved", () => {
    const first = plan({ movements: statement.slice(0, 2), throughMonth: "2027-01" });
    const stored = asStored(first.writes);
    const december = stored.find((s) => s.date === "2026-12-01")!;
    december.date = "2026-12-15";

    const next = plan({ movements: statement.slice(0, 2), stored, throughMonth: "2027-01" });
    expect(next.writes.some((w) => w.snapshot_id === december.snapshot_id)).toBe(false);
    expect(next.retire).not.toContain(december.snapshot_id);
    // December's 1st still gets an opening, under an id of its own.
    const opening = next.writes.find((w) => w.snapshot_date.startsWith("2026-12-01"));
    expect(opening).toBeDefined();
    expect(opening!.snapshot_id).not.toBe(december.snapshot_id);
    // And it's recognised as the engine's own afterwards.
    const settled = plan({ movements: statement.slice(0, 2), stored: [...stored, ...asStored(next.writes)], throughMonth: "2027-01" });
    expect(settled.writes).toEqual([]);
  });

  test("an entered position with no cost leaves the cost unknown through fees", () => {
    const result = plan({
      stored: [entered("2026-01-02", 100, { cost_basis: null })],
      movements: [tx("2026-02-27", "sell", -0.2, -9.6, 48), tx("2026-03-31", "sell", -0.2, -9.6, 48)],
      throughMonth: "2026-04",
    });
    expect(result.writes.length).toBeGreaterThan(0);
    expect(result.writes.every((w) => w.cost_basis === null)).toBe(true);
    expect(result.final!.position).toMatchObject({ quantity: 99.6, costBasis: null });
    // Unknown cost still reads back as the engine's own.
    expect(plan({ ...{ stored: [entered("2026-01-02", 100, { cost_basis: null }), ...asStored(result.writes)] }, movements: [tx("2026-02-27", "sell", -0.2, -9.6, 48), tx("2026-03-31", "sell", -0.2, -9.6, 48)], throughMonth: "2026-04" }).writes).toEqual([]);
  });

  test("a buy on top of an unknown cost doesn't make one up", () => {
    const result = plan({
      stored: [entered("2026-01-02", 100, { cost_basis: null })],
      movements: [tx("2026-02-01", "buy", 10, 500, 50)],
      throughMonth: "2026-02",
    });
    expect(result.final!.position).toMatchObject({ quantity: 110, costBasis: null });
  });

  test("an entry with no cost that the transactions already explain keeps their cost", () => {
    const result = plan({
      stored: [entered("2026-02-02", 10, { cost_basis: null })],
      movements: [tx("2026-02-01", "buy", 10, 500, 50), tx("2026-03-01", "buy", 2, 104, 52)],
      throughMonth: "2026-03",
    });
    expect(result.final!.position).toMatchObject({ quantity: 12, costBasis: 604 });
  });

  test("a later entry with a cost makes the cost known again", () => {
    const result = plan({
      stored: [entered("2026-01-02", 100, { cost_basis: null }), entered("2026-03-02", 50, { cost_basis: 150 })],
      movements: [tx("2026-04-01", "buy", 10, 500, 50)],
      throughMonth: "2026-04",
    });
    expect(result.final!.position).toMatchObject({ quantity: 60, costBasis: 650 });
  });

  test("a cost the database rounds differently from JavaScript still reads back as the engine's own", () => {
    // 1.005 is just under 1.005 in binary: toFixed(2) gives 1.00, Postgres gives 1.01.
    const movements = [tx("2026-10-06", "buy", 1, 1.005, 1.005)];
    const first = plan({ movements, throughMonth: "2026-11" });
    const stored = asStored(first.writes);
    expect(plan({ movements, stored, throughMonth: "2026-11" })).toMatchObject({ writes: [], gaps: [] });
    // Still the engine's own, so an earlier movement moves it rather than being reset by it.
    const later = plan({ movements: [tx("2026-10-01", "buy", 2, 2, 1), ...movements], stored, throughMonth: "2026-11" });
    expect(later.gaps).toEqual([]);
    expect(later.final!.position.quantity).toBe(3);
  });

  test("never writes onto an id that a row someone edited holds, whichever variant", () => {
    const movements = [tx("2026-10-06", "buy", 10, 500, 50)];
    const position = { quantity: 10, costBasis: 500, price: 50 };
    // Edited rows holding every id the 10-06 snapshot could take, each moved to another date.
    const held = [0, 1, 2, 3].map((variant, i) => ({
      snapshot_id: derivedSnapshotId("acct-1", "sec-1", "2026-10-06", position, variant),
      date: `2026-09-0${i + 1}`,
      // Empty, so the 10-06 buy lands on exactly the position those ids hash.
      quantity: 0,
      cost_basis: 0,
      institution_price: 50,
      institution_value: 0,
    }));
    const result = plan({ movements, stored: held, throughMonth: "2026-10" });
    expect(result.final).toEqual({ date: "2026-10-06", position });
    const heldIds = new Set(held.map((h) => h.snapshot_id));
    expect(result.writes.some((w) => heldIds.has(w.snapshot_id))).toBe(false);
    expect(result.retire).toEqual([]);
  });

  test("replace writes a derived snapshot on a movement day an entered snapshot shared", () => {
    const own = entered("2026-10-06", 100);
    const result = plan({ movements: statement, stored: [own], replace: true });
    expect(result.retire).toContain(own.snapshot_id);
    expect(quantities(result)).toContainEqual(["2026-10-06", 10]);
  });

  test("a movement with no price keeps the last known price", () => {
    const result = plan({
      movements: [tx("2026-10-06", "buy", 10, 500, 50), tx("2026-10-20", "buy", 1, 0, 0)],
      throughMonth: "2026-10",
    });
    expect(result.writes.find((w) => w.snapshot_date.startsWith("2026-10-20"))).toMatchObject({
      quantity: 11,
      institution_price: 50,
      institution_value: 550,
    });
  });
});

describe("positionBefore", () => {
  const before = (date: string, stored: StoredHoldingSnapshot[] = [], movements = statement) =>
    positionBefore({ account_id: "acct-1", security_id: "sec-1", movements, stored, date });

  test("counts only days before the date: a movement on the date itself isn't held yet", () => {
    expect(before("2026-11-03")).toEqual({ quantity: 10, costBasis: 500 });
    expect(before("2026-11-04")).toEqual({ quantity: 12, costBasis: 604 });
  });

  test("an entered snapshot resets at the end of its day", () => {
    const stored = [entered("2026-10-20", 100, { cost_basis: 300 })];
    expect(before("2026-10-20", stored)).toEqual({ quantity: 10, costBasis: 500 });
    expect(before("2026-10-21", stored)).toEqual({ quantity: 100, costBasis: 300 });
    expect(before("2026-11-04", stored)).toEqual({ quantity: 102, costBasis: 404 });
  });

  test("sales draw on the entered shares, capped at what's held", () => {
    const stored = [entered("2026-01-02", 100)];
    const sells = [tx("2026-02-01", "sell", -30, -1440, 48), tx("2026-03-01", "sell", -500, -24000, 48)];
    expect(before("2026-02-02", stored, sells).quantity).toBe(70);
    expect(before("2026-03-02", stored, sells).quantity).toBe(0);
  });

  test("agrees with what the engine writes for the day before", () => {
    const stored = [entered("2026-01-02", 100), entered("2026-03-02", 50)];
    const movements = [tx("2026-02-10", "buy", 10, 500, 50), tx("2026-04-10", "sell", -5, -250, 50)];
    const planned = plan({ stored, movements, throughMonth: "2026-04" });
    const april9 = planned.writes.filter((w) => w.snapshot_date < "2026-04-10").at(-1)!;
    expect(positionBefore({ account_id: "acct-1", security_id: "sec-1", movements, stored, date: "2026-04-10" }).quantity).toBe(
      april9.quantity!,
    );
  });
});

describe("isEnteredSnapshot", () => {
  test("a derived snapshot left as written isn't entered; the same row edited, or moved to another date, is", () => {
    const written = asStored(plan({ movements: statement.slice(0, 1), throughMonth: "2026-10" }).writes)[0];
    expect(isEnteredSnapshot("acct-1", "sec-1", written, [written])).toBe(false);
    const edited = { ...written, quantity: 11, institution_value: 11 * written.institution_price! };
    expect(isEnteredSnapshot("acct-1", "sec-1", edited, [edited])).toBe(true);
    const moved = { ...written, date: "2026-10-09" };
    expect(isEnteredSnapshot("acct-1", "sec-1", moved, [moved])).toBe(true);
  });

  test("an Add Holding snapshot is entered", () => {
    const own = entered("2026-01-02", 100);
    expect(isEnteredSnapshot("acct-1", "sec-1", own, [own])).toBe(true);
  });

  test("two entered snapshots on one day: the later id is the one the walk resets to", () => {
    const a = entered("2026-01-02", 100, { snapshot_id: "holding-a" });
    const b = entered("2026-01-02", 80, { snapshot_id: "holding-b" });
    expect(isEnteredSnapshot("acct-1", "sec-1", a, [b, a])).toBe(false);
    expect(isEnteredSnapshot("acct-1", "sec-1", b, [b, a])).toBe(true);
    expect(enteredResetPoints("acct-1", "sec-1", [b, a]).get("2026-01-02")).toBe(b);
    expect(positionBefore({ account_id: "acct-1", security_id: "sec-1", movements: [], stored: [a, b], date: "2026-01-03" }).quantity).toBe(80);
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
