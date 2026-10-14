import { describe, expect, test } from "bun:test";
import {
  derivePositions,
  enteredResetPoints,
  EnteredPosition,
  isDerivedPositionTransactionId,
  Movement,
  positionBefore,
} from "./holding-positions";

const tx = (date: string, type: string, quantity: number, amount: number, price: number, id?: string) =>
  ({ date, type, quantity, amount, price, investment_transaction_id: id }) as Movement;

const entered = (date: string, quantity: number, over: Partial<EnteredPosition> = {}): EnteredPosition => ({
  snapshot_id: `holding-acct-1-sec-1-${date.replaceAll("-", "")}`,
  date,
  quantity,
  cost_basis: quantity * 3,
  institution_price: 48,
  ...over,
});

const derive = (over: Partial<Parameters<typeof derivePositions>[0]>) =>
  derivePositions({ movements: [], entered: [], throughMonth: "2027-01", ...over });

const last = (result: ReturnType<typeof derivePositions>) => result.positions[result.positions.length - 1].position;

const statement = [
  tx("2026-10-06", "buy", 10, 500, 50),
  tx("2026-11-03", "buy", 2, 104, 52),
  tx("2026-12-18", "buy", 0.5, 27, 54),
];

describe("derivePositions", () => {
  test("a position on each movement day and each later month's 1st", () => {
    const { positions } = derive({ movements: statement, throughMonth: "2027-01" });
    expect(positions.map((p) => [p.date, p.position.quantity])).toEqual([
      ["2026-10-06", 10],
      ["2026-11-01", 10],
      ["2026-11-03", 12],
      ["2026-12-01", 12],
      ["2026-12-18", 12.5],
      ["2027-01-01", 12.5],
    ]);
    expect(last(derive({ movements: statement }))).toEqual({ quantity: 12.5, costBasis: 631, price: 54 });
  });

  test("sales draw on an entered position: fees and a withdrawal after 100 entered units", () => {
    const result = derive({
      entered: [entered("2026-01-02", 100)],
      movements: [
        tx("2026-02-27", "sell", -0.2, -9.6, 48),
        tx("2026-03-31", "sell", -0.2, -9.6, 48),
        tx("2026-05-15", "sell", -20, -960, 48),
      ],
      throughMonth: "2026-06",
    });
    expect(last(result).quantity).toBeCloseTo(79.6, 6);
  });

  test("a sale after an entered position takes basis at the average cost of the whole position", () => {
    const result = derive({
      entered: [entered("2026-01-02", 100, { cost_basis: 300 })],
      movements: [tx("2026-02-01", "buy", 10, 500, 50), tx("2026-03-01", "sell", -5, -250, 50)],
      throughMonth: "2026-03",
    });
    expect(last(result).quantity).toBe(105);
    expect(last(result).costBasis).toBeCloseTo(800 - (800 / 110) * 5, 2);
  });

  test("each entered position is a reset point, and the ones transactions don't explain are gaps", () => {
    const result = derive({
      entered: [entered("2026-01-02", 100), entered("2026-03-02", 50)],
      movements: [tx("2026-02-10", "buy", 10, 500, 50), tx("2026-04-10", "buy", 10, 500, 50)],
      throughMonth: "2026-04",
    });
    expect(last(result).quantity).toBe(60);
    expect(result.gaps).toEqual([
      { date: "2026-01-02", stored: 100, explained: 0 },
      { date: "2026-03-02", stored: 50, explained: 110 },
    ]);
  });

  test("replace ignores entered positions and follows the transactions alone", () => {
    const result = derive({
      entered: [entered("2026-01-02", 100)],
      movements: [tx("2026-02-10", "buy", 10, 500, 50)],
      throughMonth: "2026-02",
      replace: true,
    });
    expect(last(result).quantity).toBe(10);
    expect(result.positions.map((p) => p.date)).toEqual(["2026-02-10"]);
  });

  test("months between an entered position and the first movement carry its price, not zero", () => {
    const result = derive({
      entered: [entered("2026-01-02", 100)],
      movements: [tx("2026-04-10", "buy", 10, 500, 50)],
      throughMonth: "2026-04",
    });
    const openings = result.positions.filter((p) => ["2026-02-01", "2026-03-01"].includes(p.date));
    expect(openings.map((p) => [p.position.quantity, p.position.price])).toEqual([
      [100, 48],
      [100, 48],
    ]);
  });

  test("an entered position with no cost leaves the cost unknown, and a buy on top doesn't make one up", () => {
    const result = derive({
      entered: [entered("2026-01-02", 100, { cost_basis: null })],
      movements: [tx("2026-02-01", "buy", 10, 500, 50), tx("2026-02-27", "sell", -0.2, -9.6, 48)],
      throughMonth: "2026-03",
    });
    expect(result.positions.every((p) => p.position.costBasis === null)).toBe(true);
    expect(last(result)).toMatchObject({ quantity: 109.8, costBasis: null });
  });

  test("an entry with no cost that the transactions already explain keeps their cost", () => {
    const result = derive({
      entered: [entered("2026-02-02", 10, { cost_basis: null })],
      movements: [tx("2026-02-01", "buy", 10, 500, 50), tx("2026-03-01", "buy", 2, 104, 52)],
      throughMonth: "2026-03",
    });
    expect(last(result)).toMatchObject({ quantity: 12, costBasis: 604 });
  });

  test("a later entry with a cost makes the cost known again", () => {
    const result = derive({
      entered: [entered("2026-01-02", 100, { cost_basis: null }), entered("2026-03-02", 50, { cost_basis: 150 })],
      movements: [tx("2026-04-01", "buy", 10, 500, 50)],
      throughMonth: "2026-04",
    });
    expect(last(result)).toMatchObject({ quantity: 60, costBasis: 650 });
  });

  test("a movement with no price keeps the last known price", () => {
    const result = derive({
      movements: [tx("2026-10-06", "buy", 10, 500, 50), tx("2026-10-20", "buy", 1, 0, 0)],
      throughMonth: "2026-10",
    });
    expect(result.positions.find((p) => p.date === "2026-10-20")?.position).toMatchObject({ quantity: 11, price: 50 });
  });

  test("on one day, buys apply before sells whatever their ids, so a same-day fee isn't dropped", () => {
    // A rollover arriving and a fee leaving on the statement's first day; the fee's id sorts first.
    const movements = [tx("2026-10-06", "buy", 100, 5000, 50, "b"), tx("2026-10-06", "sell", -0.5, -25, 50, "a")];
    expect(last(derive({ movements, throughMonth: "2026-10" })).quantity).toBe(99.5);
  });
});

describe("positionBefore", () => {
  const before = (date: string, positions: EnteredPosition[] = [], movements = statement) =>
    positionBefore({ movements, entered: positions, date });

  test("counts only days before the date: a movement on the date itself isn't held yet", () => {
    expect(before("2026-11-03")).toEqual({ quantity: 10, costBasis: 500 });
    expect(before("2026-11-04")).toEqual({ quantity: 12, costBasis: 604 });
  });

  test("an entered position resets at the end of its day", () => {
    const positions = [entered("2026-10-20", 100, { cost_basis: 300 })];
    expect(before("2026-10-20", positions)).toEqual({ quantity: 10, costBasis: 500 });
    expect(before("2026-10-21", positions)).toEqual({ quantity: 100, costBasis: 300 });
    expect(before("2026-11-04", positions)).toEqual({ quantity: 102, costBasis: 404 });
  });

  test("sales draw on the entered shares, capped at what's held", () => {
    const positions = [entered("2026-01-02", 100)];
    const sells = [tx("2026-02-01", "sell", -30, -1440, 48), tx("2026-03-01", "sell", -500, -24000, 48)];
    expect(before("2026-02-02", positions, sells).quantity).toBe(70);
    expect(before("2026-03-02", positions, sells).quantity).toBe(0);
  });

  test("agrees with the derived position on the day before", () => {
    const positions = [entered("2026-01-02", 100), entered("2026-03-02", 50)];
    const movements = [tx("2026-02-10", "buy", 10, 500, 50), tx("2026-04-10", "sell", -5, -250, 50)];
    const derived = derive({ entered: positions, movements, throughMonth: "2026-04" });
    const april9 = derived.positions.filter((p) => p.date < "2026-04-10").at(-1)!;
    expect(positionBefore({ movements, entered: positions, date: "2026-04-10" }).quantity).toBe(april9.position.quantity);
  });
});

describe("enteredResetPoints", () => {
  test("two entered positions on one day: the later id is the one the walk resets to", () => {
    const a = entered("2026-01-02", 100, { snapshot_id: "holding-a" });
    const b = entered("2026-01-02", 80, { snapshot_id: "holding-b" });
    expect(enteredResetPoints([b, a]).get("2026-01-02")).toBe(b);
    expect(positionBefore({ movements: [], entered: [a, b], date: "2026-01-03" }).quantity).toBe(80);
  });
});

describe("isDerivedPositionTransactionId", () => {
  test("only imported rows make a holding's positions derived", () => {
    expect(isDerivedPositionTransactionId(`plan-${"a".repeat(32)}`)).toBe(true);
    expect(isDerivedPositionTransactionId("manual-123")).toBe(false);
  });
});
