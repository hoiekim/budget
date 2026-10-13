import { describe, expect, test } from "bun:test";
import type { DailyClose } from "../daily-closes";
import type { StatementRow } from "./parse";
import {
  buildImportPlan,
  checkRestatement,
  classifyRow,
  closeOnOrBefore,
  FundMapping,
  getCarryForwardPositions,
  getDailyPositions,
  getRowIds,
  PlanInput,
} from "./plan";

const row = (over: Partial<StatementRow>): StatementRow => ({
  line: 1,
  date: "2026-03-02",
  investment: "EXAMPLE INDEX FUND",
  label: "Contributions",
  amount: 100,
  shares: 2,
  ...over,
});

const INDEX_FUND: FundMapping = { security_id: "sec-index", restated: false, ticker_symbol: "XIDX" };
const TRUST: FundMapping = { security_id: "sec-public", restated: true, ticker_symbol: "XPUB" };

const input = (over: Partial<PlanInput>): PlanInput => ({
  account_id: "acct-1",
  iso_currency_code: "USD",
  rows: [],
  mappings: new Map([["EXAMPLE INDEX FUND", INDEX_FUND]]),
  decisions: {},
  closes: new Map(),
  existingIds: new Set(),
  ...over,
});

describe("classifyRow", () => {
  test.each([
    ["Contributions", 100, 2, { status: "write", kind: "contribution" }],
    ["Dividend", 3, 0.05, { status: "write", kind: "dividend" }],
    ["Advisor Fee", -4, -0.08, { status: "write", kind: "fee" }],
    ["Consultant Fees", -4, -0.08, { status: "write", kind: "fee" }],
    ["Conversion Balance", 5000, 100, { status: "write", kind: "rollover_in" }],
    ["Transfers", 0, 0, { status: "skip" }],
    ["Change in Market Value", 25, 0, { status: "skip" }],
    ["Change in Market Value", 25, 0.5, { status: "decide" }],
    ["Transfers", 50, 1, { status: "decide" }],
    ["Withdrawals", -500, -10, { status: "decide" }],
    ["Realized Gain/Loss", 12, 0, { status: "decide" }],
    ["Loan Repayment", 40, 0.8, { status: "decide" }],
    ["Contributions", 100, 0, { status: "decide" }],
  ])("%s %d / %d shares", (label, amount, shares, expected) => {
    expect(classifyRow({ label, amount, shares })).toMatchObject(expected);
  });
});

describe("getRowIds", () => {
  test("the same row gets the same id in every statement it appears in", () => {
    const [first] = getRowIds("acct-1", [row({ line: 9 }), row({ date: "2026-04-01" })]);
    const [, second] = getRowIds("acct-1", [row({ date: "2026-01-01" }), row({ line: 30 })]);
    expect(first).toBe(second);
  });

  test("identical rows on one day get different ids, and another account gets its own", () => {
    const ids = getRowIds("acct-1", [row({}), row({})]);
    expect(new Set(ids).size).toBe(2);
    expect(getRowIds("acct-2", [row({})])[0]).not.toBe(ids[0]);
  });

  test("any field that differs changes the id", () => {
    const [base] = getRowIds("acct-1", [row({})]);
    for (const over of [{ date: "2026-03-03" }, { investment: "OTHER" }, { label: "Dividend" }, { amount: 100.01 }, { shares: 2.000001 }]) {
      expect(getRowIds("acct-1", [row(over)])[0]).not.toBe(base);
    }
  });
});

describe("closeOnOrBefore", () => {
  const bars: DailyClose[] = [
    { date: "2026-03-02", close: 50, adjustedClose: 49 },
    { date: "2026-03-06", close: 51, adjustedClose: 50 },
  ];
  test("a weekend date takes the prior trading day", () => {
    expect(closeOnOrBefore(bars, "2026-03-08")?.date).toBe("2026-03-06");
  });
  test("nothing within a week before the date is no close", () => {
    expect(closeOnOrBefore(bars, "2026-03-01")).toBeUndefined();
    expect(closeOnOrBefore(bars, "2026-03-20")).toBeUndefined();
  });
});

describe("checkRestatement", () => {
  const bars: DailyClose[] = [
    { date: "2026-03-02", close: 50, adjustedClose: 40 },
    { date: "2026-03-16", close: 52, adjustedClose: 42 },
  ];
  test("a unit price that stays a fixed multiple of the adjusted close passes", () => {
    const result = checkRestatement(
      [row({ date: "2026-03-02", amount: 80, shares: 4 }), row({ date: "2026-03-16", amount: 84, shares: 4 })],
      bars,
      "XPUB",
    );
    expect(result.ok).toBe(true);
    expect(result.spread).toBeCloseTo(0, 10);
  });

  test("drift past 1.5% refuses, and the check uses the adjusted close, not the raw one", () => {
    // 20/40 = 0.5 vs 21.5/42 = 0.5119: 2.4% apart on adjusted closes,
    // but 20/50 = 0.4 vs 21.5/52 = 0.4135 is 3.4% on raw closes.
    const result = checkRestatement(
      [row({ date: "2026-03-02", amount: 80, shares: 4 }), row({ date: "2026-03-16", amount: 86, shares: 4 })],
      bars,
      "XPUB",
    );
    expect(result.ok).toBe(false);
    expect(result.spread).toBeCloseTo(0.02381, 4);
  });

  test("a row with no close near its date refuses", () => {
    expect(checkRestatement([row({ date: "2026-02-01" })], bars, "XPUB").ok).toBe(false);
  });
});

describe("buildImportPlan", () => {
  test("a contribution writes a buy and a cash row arriving, both from the statement's figures", () => {
    const plan = buildImportPlan(input({ rows: [row({ amount: 1234.56, shares: 9.876 })] }));
    expect(plan.blockers).toEqual([]);
    const [buy, cash] = plan.transactions.map((t) => t.transaction);
    expect(buy).toMatchObject({
      security_id: "sec-index",
      type: "buy",
      subtype: "contribution",
      amount: 1234.56,
      quantity: 9.876,
      source: "manual",
    });
    expect(buy.price).toBeCloseTo(1234.56 / 9.876, 10);
    expect(cash).toMatchObject({
      investment_transaction_id: `${buy.investment_transaction_id}-cash`,
      security_id: null,
      type: "cash",
      subtype: "contribution",
      amount: -1234.56,
      quantity: 0,
    });
    expect(plan.transactions.every((t) => t.restated_from === undefined)).toBe(true);
  });

  test("a fee sells shares and its cash row leaves the account", () => {
    const plan = buildImportPlan(input({ rows: [row({ label: "Advisor Fee", amount: -4, shares: -0.08 })] }));
    const [sell, cash] = plan.transactions.map((t) => t.transaction);
    expect(sell).toMatchObject({ type: "sell", subtype: "management fee", amount: -4, quantity: -0.08 });
    expect(sell.price).toBeCloseTo(50, 10);
    expect(cash).toMatchObject({ type: "cash", subtype: "management fee", amount: 4 });
  });

  test("a restated fund buys the public fund's shares at its raw close and keeps the statement's units", () => {
    const bars: DailyClose[] = [
      { date: "2026-03-02", close: 50, adjustedClose: 40 },
      { date: "2026-03-16", close: 52, adjustedClose: 42 },
    ];
    const plan = buildImportPlan(
      input({
        rows: [
          row({ investment: "EXAMPLE TRUST", date: "2026-03-02", amount: 80, shares: 4 }),
          row({ investment: "EXAMPLE TRUST", date: "2026-03-16", amount: 84, shares: 4 }),
        ],
        mappings: new Map([["EXAMPLE TRUST", TRUST]]),
        closes: new Map([["EXAMPLE TRUST", bars]]),
      }),
    );
    expect(plan.blockers).toEqual([]);
    const buys = plan.transactions.filter((t) => t.transaction.type === "buy");
    expect(buys.map((t) => t.transaction.security_id)).toEqual(["sec-public", "sec-public"]);
    expect(buys.map((t) => t.transaction.price)).toEqual([50, 52]);
    expect(buys.map((t) => t.transaction.amount)).toEqual([80, 84]);
    expect(buys[0].transaction.quantity).toBeCloseTo(1.6, 10);
    expect(buys[1].transaction.quantity).toBeCloseTo(84 / 52, 10);
    expect(buys.map((t) => t.restated_from)).toEqual([
      { investment: "EXAMPLE TRUST", units: 4, unit_price: 20 },
      { investment: "EXAMPLE TRUST", units: 4, unit_price: 21 },
    ]);
    const cash = plan.transactions.filter((t) => t.transaction.type === "cash");
    expect(cash.every((t) => t.restated_from === undefined)).toBe(true);
  });

  test("a restated fund that drifts from its public fund blocks the import and writes nothing", () => {
    const bars: DailyClose[] = [
      { date: "2026-03-02", close: 50, adjustedClose: 40 },
      { date: "2026-03-16", close: 52, adjustedClose: 42 },
    ];
    const plan = buildImportPlan(
      input({
        rows: [
          row({ investment: "EXAMPLE TRUST", date: "2026-03-02", amount: 80, shares: 4 }),
          row({ investment: "EXAMPLE TRUST", date: "2026-03-16", amount: 90, shares: 4 }),
        ],
        mappings: new Map([["EXAMPLE TRUST", TRUST]]),
        closes: new Map([["EXAMPLE TRUST", bars]]),
      }),
    );
    expect(plan.transactions).toEqual([]);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toContain("can't be restated");
  });

  test("a failed closes fetch names its reason on the fund and in the blocker", () => {
    const plan = buildImportPlan(
      input({
        rows: [row({ investment: "EXAMPLE TRUST" })],
        mappings: new Map([["EXAMPLE TRUST", TRUST]]),
        closeErrors: new Map([["EXAMPLE TRUST", "Market data is busy right now"]]),
      }),
    );
    expect(plan.funds[0].restatement).toEqual({ ok: false, spread: null, message: "Market data is busy right now" });
    expect(plan.blockers).toEqual(["EXAMPLE TRUST can't be restated: Market data is busy right now"]);
  });

  test("rows already in the account are listed as imported and not written again", () => {
    const rows = [row({ date: "2026-03-02" }), row({ date: "2026-03-16" })];
    const [firstId] = getRowIds("acct-1", rows);
    const plan = buildImportPlan(input({ rows, existingIds: new Set([firstId]) }));
    expect(plan.rows.map((r) => r.status)).toEqual(["imported", "new"]);
    expect(plan.transactions.map((t) => t.transaction.date)).toEqual(["2026-03-16", "2026-03-16"]);
  });

  test("a row that needs a decision blocks the import until the user makes one", () => {
    const rows = [row({ label: "Withdrawals", amount: -500, shares: -10 })];
    const undecided = buildImportPlan(input({ rows }));
    expect(undecided.rows[0].status).toBe("decide");
    expect(undecided.blockers).toEqual(["1 row needs a decision"]);
    expect(undecided.transactions).toEqual([]);

    const id = undecided.rows[0].id;
    const leaves = buildImportPlan(input({ rows, decisions: { [id]: "withdrawal_out" } }));
    expect(leaves.blockers).toEqual([]);
    expect(leaves.transactions.map((t) => [t.transaction.type, t.transaction.subtype, t.transaction.amount])).toEqual([
      ["sell", "sell", -500],
      ["cash", "withdrawal", 500],
    ]);

    const stays = buildImportPlan(input({ rows, decisions: { [id]: "withdrawal_kept" } }));
    expect(stays.transactions.map((t) => t.transaction.type)).toEqual(["sell"]);

    const skipped = buildImportPlan(input({ rows, decisions: { [id]: "skip" } }));
    expect(skipped.rows[0]).toMatchObject({ status: "skip", needsDecision: true });
    expect(skipped.transactions).toEqual([]);
  });

  test("a decision can't override a row the rules already classify", () => {
    const rows = [row({})];
    const [id] = getRowIds("acct-1", rows);
    const plan = buildImportPlan(input({ rows, decisions: { [id]: "skip" } }));
    expect(plan.rows[0].status).toBe("new");
    expect(plan.transactions).toHaveLength(2);
  });

  test("a fund with new rows and no mapping blocks the import", () => {
    const plan = buildImportPlan(input({ rows: [row({ investment: "UNMAPPED FUND" })] }));
    expect(plan.blockers).toEqual(["Map UNMAPPED FUND to a security"]);
    expect(plan.funds).toEqual([{ investment: "UNMAPPED FUND", mapping: null, newRows: 1 }]);
    expect(plan.transactions).toEqual([]);
  });

  test("an unmapped fund whose rows are all imported or skipped doesn't block", () => {
    const rows = [row({ investment: "UNMAPPED FUND", label: "Transfers", amount: 0, shares: 0 })];
    expect(buildImportPlan(input({ rows })).blockers).toEqual([]);
  });
});

describe("getDailyPositions", () => {
  const tx = (date: string, type: string, quantity: number, amount: number, price: number) =>
    ({ date, type, quantity, amount, price }) as Parameters<typeof getDailyPositions>[0][number];

  test("walks buys and sells in date order with average cost, ignoring cash rows", () => {
    const positions = getDailyPositions([
      tx("2026-03-16", "sell", -5, -300, 60),
      tx("2026-03-02", "buy", 10, 500, 50),
      tx("2026-03-02", "cash", 0, -500, 0),
      tx("2026-03-30", "buy", 2, 130, 65),
    ]);
    expect(Array.from(positions.keys())).toEqual(["2026-03-02", "2026-03-16", "2026-03-30"]);
    expect(positions.get("2026-03-02")).toEqual({ quantity: 10, costBasis: 500, price: 50 });
    // Selling half removes half the basis, not the proceeds.
    expect(positions.get("2026-03-16")).toEqual({ quantity: 5, costBasis: 250, price: 60 });
    expect(positions.get("2026-03-30")).toEqual({ quantity: 7, costBasis: 380, price: 65 });
  });

  test("months with no movement get the position they opened with, through the given month", () => {
    const positions = getDailyPositions([
      tx("2026-01-20", "buy", 10, 500, 50),
      tx("2026-03-05", "buy", 2, 110, 55),
    ]);
    expect(getCarryForwardPositions(positions, "2026-05")).toEqual([
      { date: "2026-02-01", position: { quantity: 10, costBasis: 500, price: 50 } },
      { date: "2026-04-01", position: { quantity: 12, costBasis: 610, price: 55 } },
      { date: "2026-05-01", position: { quantity: 12, costBasis: 610, price: 55 } },
    ]);
  });

  test("a sold-out holding isn't carried forward", () => {
    const positions = getDailyPositions([tx("2026-01-20", "buy", 1, 50, 50), tx("2026-01-25", "sell", -1, -55, 55)]);
    expect(getCarryForwardPositions(positions, "2026-03")).toEqual([]);
  });

  test("two movements on one day report the end-of-day position", () => {
    const positions = getDailyPositions([tx("2026-03-02", "buy", 1, 50, 50), tx("2026-03-02", "buy", 2, 100, 50)]);
    expect(positions.get("2026-03-02")?.quantity).toBe(3);
  });
});
