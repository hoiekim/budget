import { describe, expect, test } from "bun:test";
import type { EnteredPosition, Movement } from "../holding-positions";
import { FundMapping, getRowIds } from "./plan";
import { parsePlanStatement } from "./parse";
import {
  HeldMovement,
  inferencePeriod,
  previewPlanStatement,
  PreviewInput,
  PlanStatementPreview,
  restatementClosesRange,
} from "./preview";
import { getReinvestmentId, INFERRED_REINVESTMENT_NAME } from "./reinvest";

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
    deletedIds: new Set<string>(),
    accountRows: [],
    replace: new Set<string>(),
    holding: () => ({ movements: held.movements ?? [], entered: held.entered ?? [] }),
    throughMonth: "2026-04",
    ...over,
  }) as PreviewInput;

const preview = (over: Partial<PreviewInput> = {}, held = {}) => previewPlanStatement(input(over, held)) as PlanStatementPreview;

let planRows = 0;
const planRow = (date: string) => ({
  investment_transaction_id: `plan-${String(++planRows).padStart(32, "0")}`,
  date,
});

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
        { investment: "EXAMPLE INDEX FUND", ex_date: "2026-03-16", amount: 1, quantity: 1 / 49, topUp: false },
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

    test("aren't inferred when an earlier import wrote reported dividends, but an inferred one or a top-up doesn't stop them", () => {
      const reported = {
        ...buyOf("2026-01-15", 0.1),
        investment_transaction_id: "plan-reported",
        subtype: "dividend reinvestment",
        name: "Buy (dividend reinvestment)",
      };
      expect(preview({ mappings: restated, closes }, { movements: [reported] }).reinvestments).toEqual([]);
      const inferred = { ...reported, name: INFERRED_REINVESTMENT_NAME };
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
        {
          investment: "EXAMPLE INDEX FUND / EXAMPLE INDEX FUND B",
          ex_date: "2026-03-16",
          amount: 2,
          quantity: 2 / 49,
          topUp: false,
        },
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
        { investment: "EXAMPLE TRUST", ex_date: "2026-03-16", amount: 1.5, quantity: 1.5 / 49, topUp: false },
      ]);
      expect(result.request!.holdings.find((h) => h.security_id === "sec-trust")?.quantity).toBeCloseTo(3 + 1.5 / 49, 10);
      expect(result.request!.mappings.map((m) => m.investment)).toEqual(["EXAMPLE INDEX FUND"]);
    });

    test("Replace on either fund of one security applies to the holding as a whole", () => {
      const csv = [
        CSV,
        '03/02/2026,EXAMPLE INDEX FUND B,Contributions,"100.00","2.000"',
        '04/01/2026,EXAMPLE INDEX FUND B,Contributions,"100.00","2.000"',
      ].join("\n");
      const twoFunds = new Map([...restated, ["EXAMPLE INDEX FUND B", { ...MAPPING, restated: true }]]);
      const twoCloses = new Map([...closes, ["EXAMPLE INDEX FUND B", { bars }]]);
      const held = { entered: [entered("2026-01-02", 10)] };
      for (const fund of ["EXAMPLE INDEX FUND", "EXAMPLE INDEX FUND B"]) {
        const result = preview({ csv, mappings: twoFunds, closes: twoCloses, replace: new Set([fund]) }, held);
        expect(result.reinvestments[0].amount).toBe(2);
        expect(result.request!.replace).toEqual(["sec-index"]);
        expect(result.request!.holdings[0].quantity).toBeCloseTo(8 + 2 / 49, 10);
        expect(result.funds.map((f) => f.replacePositions)).toEqual([true, true]);
      }
    });

    test("a restated holding whose prices haven't loaded blocks the import, and says it can be retried", () => {
      const other = new Map([
        ["EXAMPLE INDEX FUND", MAPPING],
        ["EXAMPLE TRUST", { security_id: "sec-trust", restated: true, ticker_symbol: "XTR" }],
      ]);
      const loading = new Map([["EXAMPLE TRUST", { message: "Prices for XTR are loading…" }]]);
      const result = preview({ mappings: other, closes: loading }, { movements: [buyOf("2026-01-15", 3)] });
      expect(result.blockers).toEqual(["EXAMPLE TRUST: Prices for XTR are loading…"]);
      expect(result.retryCloses).toBe(true);
      expect(result.request).toBeNull();
      const nothingHeld = preview({ mappings: other, closes: loading });
      expect(nothingHeld.blockers).toEqual([]);
      expect(nothingHeld.retryCloses).toBe(false);
    });

    test("cover the payouts since the latest earlier plan-statement row, so statements imported in order miss none", () => {
      // Payouts on 01-14, before the last earlier row, and on 02-03, between it and the statement's first row.
      const earlier = [
        { date: "2026-01-13", close: 50, adjustedClose: 48.5 },
        { date: "2026-01-14", close: 50, adjustedClose: 49 },
        { date: "2026-02-02", close: 50, adjustedClose: 49 },
        { date: "2026-02-03", close: 50, adjustedClose: 49.5 },
        ...bars,
      ];
      const result = preview(
        {
          mappings: restated,
          closes: new Map([["EXAMPLE INDEX FUND", { bars: earlier }]]),
          // A manual row after the 02-03 payout doesn't mark where an earlier import's period ended.
          accountRows: [
            planRow("2026-01-10"),
            planRow("2026-01-15"),
            { investment_transaction_id: "manual-1", date: "2026-02-10" },
          ],
        },
        { movements: [buyOf("2026-01-10", 2), buyOf("2026-01-15", 2)] },
      );
      expect(result.reinvestments.map((r) => r.ex_date)).toEqual(["2026-02-03", "2026-03-16"]);
    });

    test("inferencePeriod starts after the latest plan-statement row before the statement", () => {
      const rows = parsePlanStatement(CSV).rows;
      expect(inferencePeriod(rows, [])).toEqual({ after: null, through: "2026-04-01" });
      const accountRows = [
        planRow("2026-01-10"),
        planRow("2026-02-20T00:00:00.000Z"),
        { investment_transaction_id: "manual-1", date: "2026-02-25" },
        planRow("2026-03-02"),
        planRow("2026-05-01"),
      ];
      expect(inferencePeriod(rows, accountRows)).toEqual({ after: "2026-02-20", through: "2026-04-01" });
    });

    test("restatementClosesRange spans that period and the statement's rows", () => {
      const rows = parsePlanStatement(CSV).rows;
      expect(restatementClosesRange(rows, [])).toEqual({ from: "2026-02-20", to: "2026-04-01" });
      expect(restatementClosesRange(rows, [planRow("2026-01-09")])).toEqual({ from: "2025-12-30", to: "2026-04-01" });
      // A later statement's rows, whose reinvestments this one's rows may need to top up.
      expect(restatementClosesRange(rows, [planRow("2026-06-15")])).toEqual({ from: "2026-02-20", to: "2026-06-15" });
    });

    test("a reinvestment found deleted isn't planned again", () => {
      const deleted = preview({ mappings: restated, closes, deletedIds: new Set([exId]) });
      expect(deleted.reinvestments).toEqual([]);
      expect(deleted.request!.holdings[0].quantity).toBe(4);
    });

    test("a statement row found deleted stays out, and its shares earn nothing", () => {
      const [first] = getRowIds("acct-1", parsePlanStatement(CSV).rows);
      const result = preview({ mappings: restated, closes, deletedIds: new Set([first]) });
      expect(result.rows.map((r) => r.status)).toEqual(["imported", "new"]);
      expect(result.request!.transactions.map((t) => t.transaction.investment_transaction_id)).not.toContain(first);
      expect(result.reinvestments).toEqual([]);
      expect(result.request!.holdings[0].quantity).toBe(2);
    });

    test("one holding's missing prices stop inference for every holding", () => {
      const both = new Map([
        ...restated,
        ["EXAMPLE TRUST", { security_id: "sec-trust", restated: true, ticker_symbol: "XTR" }],
      ]);
      const someCloses = new Map([...closes, ["EXAMPLE TRUST", { message: "Prices for XTR are loading…" }]]);
      const result = preview({ mappings: both, closes: someCloses }, { movements: [buyOf("2026-01-15", 3)] });
      expect(result.blockers).toEqual(["EXAMPLE TRUST: Prices for XTR are loading…"]);
      expect(result.reinvestments).toEqual([]);
    });

    test("an ex-date already in the account isn't sent again", () => {
      const rowIds = getRowIds("acct-1", parsePlanStatement(CSV).rows);
      const result = preview({ mappings: restated, closes, existingIds: new Set([...rowIds, exId]) });
      expect(result.reinvestments).toEqual([]);
    });

    test("statements imported out of order end as if imported in order", () => {
      // Payouts of $0.50 go ex 12-22 and 02-10; units track 0.5 × the adjusted close.
      const flat = [
        ["2025-11-03", 0.9801],
        ["2025-12-17", 0.9801],
        ["2025-12-19", 0.9801],
        ["2025-12-22", 0.99],
        ["2026-01-09", 0.99],
        ["2026-02-09", 0.99],
        ["2026-02-10", 1],
        ["2026-02-24", 1],
      ] as const;
      const trustBars = flat.map(([date, factor]) => ({ date, close: 50, adjustedClose: 50 * factor }));
      const statement = (dates: string[]) =>
        [
          "Date,Investment,Transaction Type,Amount,Shares/Unit",
          ...dates.map((date) => {
            const adjusted = trustBars.find((b) => b.date === date)!.adjustedClose;
            const [y, m, d] = date.split("-");
            return `${m}/${d}/${y},EXAMPLE INDEX FUND,Contributions,"500.00","${(1000 / adjusted).toFixed(4)}"`;
          }),
        ].join("\n");
      const A = statement(["2025-11-03", "2025-12-17"]);
      const B = statement(["2026-01-09", "2026-02-24"]);
      const importInOrder = (csvs: string[]) => {
        const account: Movement[] = [];
        for (const csv of csvs) {
          const result = preview(
            {
              csv,
              mappings: restated,
              closes: new Map([["EXAMPLE INDEX FUND", { bars: trustBars }]]),
              existingIds: new Set(account.map((m) => m.investment_transaction_id!)),
              accountRows: account.map((m) => ({ investment_transaction_id: m.investment_transaction_id!, date: m.date })),
              throughMonth: "2026-03",
            },
            { movements: account },
          );
          account.push(...result.request!.transactions.map((t) => t.transaction as Movement));
        }
        const shares = account.reduce((sum, m) => sum + (m.type === "buy" ? m.quantity : 0), 0);
        const dividends = account
          .filter((m) => (m as HeldMovement).subtype === "dividend")
          .reduce((sum, m) => sum - m.amount, 0);
        return { shares, dividends: Math.round(dividends * 100) / 100 };
      };
      const inOrder = importInOrder([A, B]);
      expect(inOrder.dividends).toBe(25.1);
      const outOfOrder = importInOrder([B, A, B]);
      expect(outOfOrder.dividends).toBe(inOrder.dividends);
      expect(outOfOrder.shares).toBeCloseTo(inOrder.shares, 6);
    });

    test("a blocker leaves nothing inferred, even on shares already held", () => {
      const csv = `${CSV}\n04/02/2026,EXAMPLE INDEX FUND,Transfers,"5.00","0.100"`;
      const withTrust = new Map([
        ...restated,
        ["EXAMPLE TRUST", { security_id: "sec-trust", restated: true, ticker_symbol: "XTR" }],
      ]);
      const someCloses = new Map([...closes, ["EXAMPLE TRUST", { message: "Prices for XTR are loading…" }]]);
      const result = preview({ mappings: withTrust, closes: someCloses, csv }, { movements: [buyOf("2026-01-15", 2)] });
      // The statement's own blocker stands alone; held holdings' prices are only checked once nothing else blocks.
      expect(result.blockers).toEqual(["1 row needs a decision"]);
      expect(result.reinvestments).toEqual([]);
    });
  });

  test("a file with no statement rows is an error, not a preview", () => {
    expect(previewPlanStatement(input({ csv: "no header here" }))).toEqual({
      error: 'No "Date,Investment,Transaction Type,Amount,Shares/Unit" header found.',
    });
  });
});
