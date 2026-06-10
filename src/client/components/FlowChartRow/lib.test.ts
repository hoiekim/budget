import { describe, test, expect } from "bun:test";
import { ViewDate } from "common";
import {
  Account,
  Budget,
  BudgetDictionary,
  Category,
  CategoryDictionary,
  Section,
  SectionDictionary,
  Transaction,
  TransactionDictionary,
  InvestmentTransactionDictionary,
} from "client";
import { getSankeyData } from "./lib";

// ---------------------------------------------------------------------------
// Fixture helpers — minimal shapes that exercise getSankeyData's aggregation.
// We're testing the partition-by-net logic, not the model classes themselves.
// ---------------------------------------------------------------------------

const TX_DATE = "2026-06-05T00:00:00";
const view = new ViewDate("month", new Date(2026, 5, 15)); // June 2026

const makeBudget = (id: string, name: string): Budget =>
  new Budget({
    budget_id: id,
    name,
    iso_currency_code: "USD",
    capacities: [{ capacity_id: "c", month: 0 }],
  });

const makeSection = (id: string, name: string, budget_id: string): Section =>
  new Section({
    section_id: id,
    budget_id,
    name,
    capacities: [{ capacity_id: "c", month: 0 }],
  });

const makeCategory = (id: string, name: string, section_id: string): Category =>
  new Category({
    category_id: id,
    section_id,
    name,
    capacities: [{ capacity_id: "c", month: 0 }],
  });

const makeAccount = (id: string, budget_id: string): Account =>
  new Account({
    account_id: id,
    name: "Account",
    balances: { available: 0, current: 0, iso_currency_code: "USD" } as never,
    label: { budget_id },
    hide: false,
  } as never);

const makeTx = (id: string, account_id: string, amount: number, label: object): Transaction =>
  new Transaction({
    transaction_id: id,
    account_id,
    amount,
    date: TX_DATE,
    authorized_date: TX_DATE,
    label: label as never,
    iso_currency_code_at_purchase: "USD",
  } as never);

const sankeyTotalsBySectionId = (sankey: ReturnType<typeof getSankeyData>) => {
  const out = new Map<string, { side: "income" | "expense"; amount: number }>();
  // column1 = income sections; column5 = expense sections
  sankey.graphData[0].forEach((r) => out.set(r.id, { side: "income", amount: r.amount }));
  sankey.graphData[4].forEach((r) => out.set(r.id, { side: "expense", amount: r.amount }));
  return out;
};

describe("getSankeyData — net-by-section partition", () => {
  const buildScene = (txs: Transaction[]) => {
    const budgets = new BudgetDictionary();
    budgets.set("budget-expense", makeBudget("budget-expense", "Spending"));
    budgets.set("budget-income", makeBudget("budget-income", "Income"));
    budgets.set("budget-transfer", makeBudget("budget-transfer", "Transfers"));

    const sections = new SectionDictionary();
    sections.set("sec-shopping", makeSection("sec-shopping", "Shopping", "budget-expense"));
    sections.set("sec-salary", makeSection("sec-salary", "Salary", "budget-income"));
    sections.set("sec-transfer", makeSection("sec-transfer", "Transfers", "budget-transfer"));

    const categories = new CategoryDictionary();
    categories.set("cat-shopping", makeCategory("cat-shopping", "Misc", "sec-shopping"));
    categories.set("cat-salary", makeCategory("cat-salary", "Paycheck", "sec-salary"));
    categories.set("cat-transfer", makeCategory("cat-transfer", "Transfers", "sec-transfer"));

    const accounts = [
      makeAccount("acc-1", "budget-expense"),
      makeAccount("acc-2", "budget-income"),
    ];

    const txDict = new TransactionDictionary();
    txs.forEach((t) => txDict.set(t.transaction_id, t));

    return getSankeyData(
      accounts,
      txDict,
      new InvestmentTransactionDictionary(),
      budgets,
      sections,
      categories,
      view,
    );
  };

  test("transfer pair (one section, +X and −X) → section drops from BOTH sides; income/expense unchanged", () => {
    // Two transfer legs labeled to the Transfers section. The signed sum
    // is 0; nothing should land on either side of the chart.
    const result = buildScene([
      makeTx("tx-a", "acc-1", 100, { budget_id: "budget-transfer", category_id: "cat-transfer" }),
      makeTx("tx-b", "acc-2", -100, { budget_id: "budget-transfer", category_id: "cat-transfer" }),
    ]);

    const totals = sankeyTotalsBySectionId(result);
    expect(totals.has("sec-transfer")).toBe(false);
    expect(result.tableData.income).toBe(0);
    expect(result.tableData.expense).toBe(0);
  });

  test("pure expense section (Shopping, all positive amounts) → routes to expense side only", () => {
    const result = buildScene([
      makeTx("tx-1", "acc-1", 50, { budget_id: "budget-expense", category_id: "cat-shopping" }),
      makeTx("tx-2", "acc-1", 30, { budget_id: "budget-expense", category_id: "cat-shopping" }),
    ]);

    const totals = sankeyTotalsBySectionId(result);
    expect(totals.get("sec-shopping")).toEqual({ side: "expense", amount: 80 });
    expect(result.tableData.expense).toBe(80);
    expect(result.tableData.income).toBe(0);
  });

  test("pure income section (Salary, all negative amounts) → routes to income side only with absolute magnitude", () => {
    const result = buildScene([
      makeTx("tx-3", "acc-2", -2000, { budget_id: "budget-income", category_id: "cat-salary" }),
    ]);

    const totals = sankeyTotalsBySectionId(result);
    expect(totals.get("sec-salary")).toEqual({ side: "income", amount: 2000 });
    expect(result.tableData.income).toBe(2000);
    expect(result.tableData.expense).toBe(0);
  });

  test("mixed section (refund inside Shopping) → routes to net-sign side with REDUCED magnitude", () => {
    // $200 purchase + $50 refund → net $150 expense.
    // Pre-fix this would have shown $200 on expense AND $50 on income for
    // the same section. Post-fix: only $150 on expense.
    const result = buildScene([
      makeTx("tx-buy", "acc-1", 200, { budget_id: "budget-expense", category_id: "cat-shopping" }),
      makeTx("tx-refund", "acc-1", -50, { budget_id: "budget-expense", category_id: "cat-shopping" }),
    ]);

    const totals = sankeyTotalsBySectionId(result);
    expect(totals.get("sec-shopping")).toEqual({ side: "expense", amount: 150 });
    expect(result.tableData.expense).toBe(150);
    expect(result.tableData.income).toBe(0);
  });

  test("multiple sections — independent partition", () => {
    const result = buildScene([
      makeTx("tx-buy", "acc-1", 100, { budget_id: "budget-expense", category_id: "cat-shopping" }),
      makeTx("tx-pay", "acc-2", -500, { budget_id: "budget-income", category_id: "cat-salary" }),
      // transfer pair — should drop entirely
      makeTx("tx-out", "acc-1", 200, { budget_id: "budget-transfer", category_id: "cat-transfer" }),
      makeTx("tx-in", "acc-2", -200, { budget_id: "budget-transfer", category_id: "cat-transfer" }),
    ]);

    const totals = sankeyTotalsBySectionId(result);
    expect(totals.get("sec-shopping")).toEqual({ side: "expense", amount: 100 });
    expect(totals.get("sec-salary")).toEqual({ side: "income", amount: 500 });
    expect(totals.has("sec-transfer")).toBe(false);
    expect(result.tableData.expense).toBe(100);
    expect(result.tableData.income).toBe(500);
  });

  test("a transaction with amount=0 is skipped (no zero rows on either side)", () => {
    const result = buildScene([
      makeTx("tx-zero", "acc-1", 0, { budget_id: "budget-expense", category_id: "cat-shopping" }),
    ]);
    expect(result.graphData[0]).toHaveLength(0);
    expect(result.graphData[4]).toHaveLength(0);
  });
});
