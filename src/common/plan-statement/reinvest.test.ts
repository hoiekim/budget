import { describe, expect, test } from "bun:test";
import type { EnteredPosition, Movement } from "../holding-positions";
import type { DailyClose } from "./plan";
import { distributionsFromCloses, getReinvestmentId, planReinvestments, ReinvestmentInput } from "./reinvest";

/** Bars whose adjusted closes carry the given payouts, built the way a provider back-adjusts them. */
const barsWith = (closes: [string, number][], payouts: Record<string, number> = {}): DailyClose[] => {
  const bars: DailyClose[] = [];
  let factor = 1;
  for (let i = closes.length - 1; i >= 0; i--) {
    const [date, close] = closes[i];
    bars.unshift({ date, close, adjustedClose: close * factor });
    const payout = payouts[date];
    if (payout && i > 0) factor *= 1 - payout / closes[i - 1][1];
  }
  return bars;
};

const CLOSES: [string, number][] = [
  ["2026-03-02", 100],
  ["2026-03-03", 101],
  ["2026-03-04", 99],
  ["2026-03-05", 100],
  ["2026-06-01", 110],
  ["2026-06-02", 108],
];

describe("distributionsFromCloses", () => {
  test("reads each payout from the step in the adjusted-to-raw ratio, at the ex-date's close", () => {
    const bars = barsWith(CLOSES, { "2026-03-04": 1.5, "2026-06-02": 0.75 });
    expect(distributionsFromCloses(bars)).toEqual([
      { ex_date: "2026-03-04", cash_amount: 1.5, close: 99 },
      { ex_date: "2026-06-02", cash_amount: 0.75, close: 108 },
    ]);
  });

  test("a typical quarterly payout of a third of a percent is read", () => {
    const bars = barsWith(CLOSES, { "2026-03-04": 0.33 });
    expect(distributionsFromCloses(bars)).toEqual([{ ex_date: "2026-03-04", cash_amount: 0.33, close: 99 }]);
  });

  test("a series with no payouts, or one rounded to a few digits, has none", () => {
    expect(distributionsFromCloses(barsWith(CLOSES))).toEqual([]);
    const rounded = barsWith(CLOSES, { "2026-03-04": 1.5 }).map((b) => ({
      ...b,
      adjustedClose: Number(b.adjustedClose.toPrecision(7)),
    }));
    expect(distributionsFromCloses(rounded).map((d) => d.ex_date)).toEqual(["2026-03-04"]);
  });

  test("a step the other way isn't a payout", () => {
    const bars = barsWith(CLOSES).map((b, i) => (i < 2 ? { ...b, adjustedClose: b.close * 1.01 } : b));
    expect(distributionsFromCloses(bars)).toEqual([]);
  });
});

const buy = (date: string, quantity: number, price = 100, id?: string): Movement => ({
  investment_transaction_id: id,
  date,
  type: "buy",
  quantity,
  amount: quantity * price,
  price,
});

const input = (over: Partial<ReinvestmentInput> = {}): ReinvestmentInput => ({
  account_id: "acct-1",
  security_id: "sec-fund",
  iso_currency_code: "USD",
  bars: barsWith(CLOSES, { "2026-03-04": 1.5, "2026-06-02": 0.75 }),
  after: null,
  through: "2026-06-30",
  movements: [buy("2026-03-02", 10)],
  entered: [],
  replace: false,
  writing: new Set(),
  liveIds: new Set(),
  existingIds: new Set(),
  ...over,
});

const buys = (over: Partial<ReinvestmentInput> = {}) =>
  planReinvestments(input(over)).filter((t) => t.transaction.type === "buy");

describe("planReinvestments", () => {
  test("each ex-date buys shares held × payout at its close, as a dividend and its reinvestment", () => {
    const [first, cash] = planReinvestments(input());
    const id = getReinvestmentId("acct-1", "sec-fund", "2026-03-04");
    expect(first.transaction).toMatchObject({
      investment_transaction_id: id,
      security_id: "sec-fund",
      date: "2026-03-04",
      type: "buy",
      subtype: "dividend reinvestment",
      amount: 15,
      price: 99,
    });
    expect(first.transaction.quantity).toBeCloseTo(15 / 99, 10);
    expect(first.reinvested_distribution).toEqual({ ex_date: "2026-03-04", cash_amount_per_share: 1.5, shares_held: 10 });
    expect(cash.transaction).toMatchObject({
      investment_transaction_id: `${id}-cash`,
      security_id: null,
      type: "cash",
      subtype: "dividend",
      amount: -15,
    });
    expect(cash.reinvested_distribution).toBeUndefined();
  });

  test("a later payout counts the shares an earlier one reinvested", () => {
    const [, second] = buys();
    const held = 10 + 15 / 99;
    expect(second.reinvested_distribution?.shares_held).toBeCloseTo(held, 6);
    expect(second.transaction.amount).toBe(Math.round(held * 0.75 * 100) / 100);
  });

  test("shares bought on the ex-date don't earn its payout", () => {
    const [first] = buys({ movements: [buy("2026-03-02", 10), buy("2026-03-04", 5)] });
    expect(first.reinvested_distribution?.shares_held).toBe(10);
  });

  test("an ex-date after the statement's last day waits for a statement that covers it", () => {
    expect(buys({ through: "2026-06-01" }).map((t) => t.transaction.date)).toEqual(["2026-03-04"]);
    expect(buys({ through: "2026-06-02" }).map((t) => t.transaction.date)).toEqual(["2026-03-04", "2026-06-02"]);
  });

  test("an ex-date on or before the account's last earlier row was an earlier import's to infer", () => {
    expect(buys({ after: "2026-03-04" }).map((t) => t.transaction.date)).toEqual(["2026-06-02"]);
    expect(buys({ after: "2026-03-03" }).map((t) => t.transaction.date)).toEqual(["2026-03-04", "2026-06-02"]);
  });

  test("an ex-date already written is left alone, and its shares count toward the next", () => {
    const id = getReinvestmentId("acct-1", "sec-fund", "2026-03-04");
    const written = buy("2026-03-04", 1, 99, id);
    const result = buys({ existingIds: new Set([id]), movements: [buy("2026-03-02", 10), written] });
    expect(result.map((t) => t.transaction.date)).toEqual(["2026-06-02"]);
    expect(result[0].reinvested_distribution?.shares_held).toBe(11);
  });

  test("nothing held on an ex-date is owed nothing", () => {
    expect(buys({ movements: [buy("2026-06-02", 10)] })).toEqual([]);
  });

  test("an entered position counts, unless the transactions are replacing it", () => {
    const entered: EnteredPosition[] = [
      { snapshot_id: "s1", date: "2026-03-02", quantity: 20, cost_basis: null, institution_price: 100 },
    ];
    expect(buys({ entered })[0].reinvested_distribution?.shares_held).toBe(20);
    expect(buys({ entered, replace: true })[0].reinvested_distribution?.shares_held).toBe(10);
  });

  test("each holding and ex-date gets its own id", () => {
    const ids = new Set([
      getReinvestmentId("acct-1", "sec-fund", "2026-03-04"),
      getReinvestmentId("acct-1", "sec-fund", "2026-06-02"),
      getReinvestmentId("acct-1", "sec-other", "2026-03-04"),
      getReinvestmentId("acct-2", "sec-fund", "2026-03-04"),
    ]);
    expect(ids.size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^plan-[0-9a-f]{32}$/);
  });

  describe("top-ups for rows dated before a written reinvestment", () => {
    const writtenId = getReinvestmentId("acct-1", "sec-fund", "2026-03-04");
    // The 03-04 reinvestment was written on 10 shares; this import adds 4 shares bought on 03-03.
    const written = buy("2026-03-04", 15 / 99, 99, writtenId);
    const backDated = buy("2026-03-03", 4, 100, "plan-new-row");
    const over = {
      through: "2026-03-31",
      movements: [buy("2026-03-02", 10, 100, "plan-old-row"), written, backDated],
      writing: new Set(["plan-new-row"]),
      liveIds: new Set([writtenId]),
      existingIds: new Set([writtenId]),
    };

    test("pay the payout on just the shares the earlier rows add", () => {
      const [topUp] = buys(over);
      expect(topUp.transaction.investment_transaction_id).not.toBe(writtenId);
      expect(topUp.transaction).toMatchObject({ date: "2026-03-04", amount: 6, price: 99 });
      expect(topUp.reinvested_distribution).toEqual({ ex_date: "2026-03-04", cash_amount_per_share: 1.5, shares_held: 4 });
    });

    test("reach written reinvestments after the statement too, compounding through them", () => {
      // 06-02 lies after the statement and isn't written, so it's a later statement's to infer.
      expect(buys({ ...over, through: "2026-03-03" }).map((t) => t.transaction.date)).toEqual(["2026-03-04"]);
      const june = getReinvestmentId("acct-1", "sec-fund", "2026-06-02");
      const withJune = buys({
        ...over,
        through: "2026-03-03",
        movements: [...over.movements, buy("2026-06-02", 0.07, 108, june)],
        liveIds: new Set([writtenId, june]),
        existingIds: new Set([writtenId, june]),
      });
      expect(withJune.map((t) => t.transaction.date)).toEqual(["2026-03-04", "2026-06-02"]);
      expect(withJune[1].reinvested_distribution?.shares_held).toBeCloseTo(4 + 6 / 99, 6);
    });

    test("aren't owed for a written reinvestment before the earlier rows, or one someone deleted", () => {
      const after = [...over.movements.slice(0, 2), buy("2026-03-05", 4, 100, "plan-new-row")];
      expect(buys({ ...over, movements: after })).toEqual([]);
      expect(buys({ ...over, liveIds: new Set() })).toEqual([]);
    });

    test("are owed for this import's own earlier reinvestments too, under an id naming them", () => {
      // Nothing new from the statement, but 03-04 is now inferred before the written 06-02.
      const june = getReinvestmentId("acct-1", "sec-fund", "2026-06-02");
      const reimport = (through: string) =>
        buys({
          through,
          movements: [buy("2026-03-02", 10, 100, "plan-old-row"), buy("2026-06-02", 0.07, 108, june)],
          liveIds: new Set([june]),
          existingIds: new Set([june]),
        });
      const [, topUp] = reimport("2026-03-31");
      expect(topUp.transaction.date).toBe("2026-06-02");
      expect(topUp.reinvested_distribution?.shares_held).toBeCloseTo(15 / 99, 6);
      const other = buys({
        through: "2026-03-31",
        bars: barsWith(CLOSES, { "2026-03-03": 1, "2026-06-02": 0.75 }),
        movements: [buy("2026-03-02", 10, 100, "plan-old-row"), buy("2026-06-02", 0.07, 108, june)],
        liveIds: new Set([june]),
        existingIds: new Set([june]),
      });
      expect(other[1].transaction.investment_transaction_id).not.toBe(topUp.transaction.investment_transaction_id);
    });

    test("aren't added twice when the same rows are imported again", () => {
      const [topUp] = buys(over);
      const again = buys({ ...over, existingIds: new Set([writtenId, topUp.transaction.investment_transaction_id]) });
      expect(again).toEqual([]);
    });
  });
});
