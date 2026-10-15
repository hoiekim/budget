import { describe, expect, test } from "bun:test";
import type { EnteredPosition, Movement } from "../holding-positions";
import { FundMapping, getRowIds } from "./plan";
import { parsePlanStatement } from "./parse";
import { previewPlanStatement, PreviewInput, PlanStatementPreview } from "./preview";
import { getReinvestmentId } from "./reinvest";

const CSV = [
  "Plan name:,EXAMPLE PLAN",
  "Date,Investment,Transaction Type,Amount,Shares/Unit",
  '03/02/2026,EXAMPLE INDEX FUND,Contributions,"100.00","2.000"',
  '04/01/2026,EXAMPLE INDEX FUND,Contributions,"100.00","2.000"',
].join("\n");

const MAPPING: FundMapping = { security_id: "sec-index", restated: false, ticker_symbol: "XIDX" };

const input = (over: Partial<PreviewInput> = {}, held: { movements?: Movement[]; entered?: EnteredPosition[] } = {}) =>
  ({
    account_id: "acct-1",
    iso_currency_code: "USD",
    csv: CSV,
    mappings: new Map([["EXAMPLE INDEX FUND", MAPPING]]),
    decisions: {},
    closes: new Map(),
    existingIds: new Set<string>(),
    replace: new Set<string>(),
    holding: () => ({ movements: held.movements ?? [], entered: held.entered ?? [] }),
    throughMonth: "2026-04",
    ...over,
  }) as PreviewInput;

const preview = (over: Partial<PreviewInput> = {}, held = {}) => previewPlanStatement(input(over, held)) as PlanStatementPreview;

const buyOf = (date: string, quantity: number, price = 50): Movement => ({
  date,
  type: "buy",
  quantity,
  amount: quantity * price,
  price,
});

const entered = (date: string, quantity: number): EnteredPosition => ({
  snapshot_id: `holding-acct-1-sec-index-${date.replaceAll("-", "")}`,
  date,
  quantity,
  cost_basis: null,
  institution_price: 50,
});

describe("previewPlanStatement", () => {
  test("plans the rows and the request that imports them", () => {
    const result = preview();
    expect(result.rows.map((r) => r.status)).toEqual(["new", "new"]);
    expect(result.request?.transactions).toHaveLength(4);
    expect(result.request?.mappings).toEqual([{ investment: "EXAMPLE INDEX FUND", security_id: "sec-index", restated: false }]);
    expect(result.request?.replace).toEqual([]);
    expect(result.request?.holdings).toEqual([
      { security_id: "sec-index", date: "2026-04-01", quantity: 4, cost_basis: 200, price: 50 },
    ]);
  });

  test("saves only the mappings of the statement's own funds", () => {
    const mappings = new Map([
      ["EXAMPLE INDEX FUND", MAPPING],
      ["ANOTHER FUND", { security_id: "sec-other", restated: false, ticker_symbol: "OTHR" }],
    ]);
    expect(preview({ mappings }).request?.mappings.map((m) => m.investment)).toEqual(["EXAMPLE INDEX FUND"]);
  });

  test("a row already in the account is listed as imported and not sent again", () => {
    const [first] = getRowIds("acct-1", parsePlanStatement(CSV).rows);
    const result = preview({ existingIds: new Set([first]) });
    expect(result.rows.map((r) => r.status)).toEqual(["imported", "new"]);
    expect(result.request?.transactions.map((t) => t.transaction.investment_transaction_id)).not.toContain(first);
  });

  test("an entered position the transactions don't explain is disclosed and kept by default", () => {
    const result = preview({}, { entered: [entered("2026-01-02", 100)] });
    expect(result.funds[0].positionGaps).toEqual([{ date: "2026-01-02", stored: 100, explained: 0 }]);
    expect(result.funds[0].replacePositions).toBe(false);
    expect(result.request?.replace).toEqual([]);
    expect(result.request?.holdings[0].quantity).toBe(104);
  });

  test("replacing sends the security to retire and holds only the transactions' shares", () => {
    const result = preview({ replace: new Set(["EXAMPLE INDEX FUND"]) }, { entered: [entered("2026-01-02", 100)] });
    expect(result.funds[0].replacePositions).toBe(true);
    expect(result.request?.replace).toEqual(["sec-index"]);
    expect(result.request?.holdings[0].quantity).toBe(4);
  });

  test("an entered position the statement's own rows explain isn't a gap", () => {
    expect(preview({}, { entered: [entered("2026-03-02", 2)] }).funds[0].positionGaps).toBeUndefined();
  });

  test("the account's other transactions on the holding count toward its position", () => {
    const movements = [{ date: "2026-02-01", type: "buy", quantity: 5, amount: 250, price: 50 } as Movement];
    expect(preview({}, { movements }).request?.holdings[0].quantity).toBe(9);
  });

  test("a blocker leaves no request to send", () => {
    const result = preview({ mappings: new Map() });
    expect(result.blockers).toEqual(["Map EXAMPLE INDEX FUND to a security"]);
    expect(result.request).toBeNull();
  });

  test("a restated fund is priced from the public fund's closes", () => {
    const mappings = new Map([["EXAMPLE INDEX FUND", { ...MAPPING, restated: true }]]);
    const bars = [
      { date: "2026-03-02", close: 100, adjustedClose: 100 },
      { date: "2026-04-01", close: 100, adjustedClose: 100 },
    ];
    const result = preview({ mappings, closes: new Map([["EXAMPLE INDEX FUND", { bars }]]) });
    expect(result.funds[0].restatement).toMatchObject({ ok: true });
    const [buy] = result.request!.transactions;
    expect(buy.transaction).toMatchObject({ price: 100, quantity: 1 });
    expect(buy.restated_from).toEqual({ investment: "EXAMPLE INDEX FUND", units: 2, unit_price: 50 });
  });

  test("closes still loading block a restated fund and say it can be retried", () => {
    const mappings = new Map([["EXAMPLE INDEX FUND", { ...MAPPING, restated: true }]]);
    const loading = { message: "Prices for XIDX are still loading. Retry in a minute.", retryable: true };
    const result = preview({ mappings, closes: new Map([["EXAMPLE INDEX FUND", loading]]) });
    expect(result.funds[0].restatement).toMatchObject({ ok: false, retryable: true });
    expect(result.request).toBeNull();
  });

  describe("inferred dividends on a restated fund", () => {
    const restated = new Map([["EXAMPLE INDEX FUND", { ...MAPPING, restated: true }]]);
    // A $0.50 payout going ex on 2026-03-16, between the statement's two rows.
    const bars = [
      { date: "2026-03-02", close: 50, adjustedClose: 49.5 },
      { date: "2026-03-13", close: 50, adjustedClose: 49.5 },
      { date: "2026-03-16", close: 49, adjustedClose: 49 },
      { date: "2026-04-01", close: 50, adjustedClose: 50 },
    ];
    const closes = new Map([["EXAMPLE INDEX FUND", { bars }]]);
    const exId = getReinvestmentId("acct-1", "sec-index", "2026-03-16");

    test("are sent with the rows, listed, and held", () => {
      const result = preview({ mappings: restated, closes });
      expect(result.reinvestments).toEqual([
        { investment: "EXAMPLE INDEX FUND", ex_date: "2026-03-16", amount: 1, quantity: 1 / 49 },
      ]);
      const ids = result.request!.transactions.map((t) => t.transaction.investment_transaction_id);
      expect(ids).toEqual(expect.arrayContaining([exId, `${exId}-cash`]));
      expect(result.request!.holdings[0].quantity).toBeCloseTo(4 + 1 / 49, 10);
    });

    test("aren't inferred for a fund that isn't restated", () => {
      const result = preview({ closes });
      expect(result.reinvestments).toEqual([]);
      expect(result.request!.transactions.map((t) => t.transaction.investment_transaction_id)).not.toContain(exId);
    });

    test("aren't inferred when the statement reports the fund's dividends itself", () => {
      const csv = `${CSV}\n'03/16/2026,EXAMPLE INDEX FUND,Dividend,"2.00","0.0404"'`.replace(/'/g, "");
      expect(preview({ csv, mappings: restated, closes }).reinvestments).toEqual([]);
    });

    test("aren't inferred when an earlier import wrote reported dividends, but an inferred one doesn't stop them", () => {
      const reported = { ...buyOf("2026-01-15", 0.1), investment_transaction_id: "plan-reported", subtype: "dividend reinvestment" };
      expect(preview({ mappings: restated, closes }, { movements: [reported] }).reinvestments).toEqual([]);
      const inferred = { ...reported, investment_transaction_id: getReinvestmentId("acct-1", "sec-index", "2026-01-15") };
      expect(preview({ mappings: restated, closes }, { movements: [inferred] }).reinvestments).toHaveLength(1);
    });

    test("count an entered position, unless the transactions replace it", () => {
      const held = { entered: [entered("2026-01-02", 10)] };
      expect(preview({ mappings: restated, closes }, held).reinvestments[0].amount).toBe(6);
      const replacing = preview({ mappings: restated, closes, replace: new Set(["EXAMPLE INDEX FUND"]) }, held);
      expect(replacing.reinvestments[0].amount).toBe(1);
    });

    test("are planned once for two funds restated into one security", () => {
      const csv = [
        CSV,
        '03/02/2026,EXAMPLE INDEX FUND B,Contributions,"100.00","2.000"',
        '04/01/2026,EXAMPLE INDEX FUND B,Contributions,"100.00","2.000"',
      ].join("\n");
      const twoFunds = new Map([...restated, ["EXAMPLE INDEX FUND B", { ...MAPPING, restated: true }]]);
      const twoCloses = new Map([...closes, ["EXAMPLE INDEX FUND B", { bars }]]);
      const result = preview({ csv, mappings: twoFunds, closes: twoCloses });
      expect(result.reinvestments).toEqual([
        { investment: "EXAMPLE INDEX FUND / EXAMPLE INDEX FUND B", ex_date: "2026-03-16", amount: 2, quantity: 2 / 49 },
      ]);
      const ids = result.request!.transactions.map((t) => t.transaction.investment_transaction_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(result.request!.holdings).toHaveLength(1);
      expect(result.request!.holdings[0].quantity).toBeCloseTo(8 + 2 / 49, 10);
    });

    test("cover the account's restated fund that the statement has no rows for", () => {
      const other = new Map([
        ["EXAMPLE INDEX FUND", MAPPING],
        ["EXAMPLE TRUST", { security_id: "sec-trust", restated: true, ticker_symbol: "XTR" }],
      ]);
      const result = preview(
        { mappings: other, closes: new Map([["EXAMPLE TRUST", { bars }]]) },
        { movements: [buyOf("2026-01-15", 3)] },
      );
      expect(result.reinvestments).toEqual([
        { investment: "EXAMPLE TRUST", ex_date: "2026-03-16", amount: 1.5, quantity: 1.5 / 49 },
      ]);
      expect(result.request!.holdings.find((h) => h.security_id === "sec-trust")?.quantity).toBeCloseTo(3 + 1.5 / 49, 10);
      expect(result.request!.mappings.map((m) => m.investment)).toEqual(["EXAMPLE INDEX FUND"]);
    });

    test("an ex-date already in the account isn't sent again", () => {
      const result = preview({ mappings: restated, closes, existingIds: new Set([exId]) });
      expect(result.reinvestments).toEqual([]);
    });

    test("a blocker leaves nothing inferred, even on shares already held", () => {
      const csv = `${CSV}\n04/02/2026,EXAMPLE INDEX FUND,Transfers,"5.00","0.100"`;
      const result = preview({ mappings: restated, closes, csv }, { movements: [buyOf("2026-01-15", 2)] });
      expect(result.blockers).not.toEqual([]);
      expect(result.reinvestments).toEqual([]);
    });
  });

  test("a file with no statement rows is an error, not a preview", () => {
    expect(previewPlanStatement(input({ csv: "no header here" }))).toEqual({
      error: 'No "Date,Investment,Transaction Type,Amount,Shares/Unit" header found.',
    });
  });
});
