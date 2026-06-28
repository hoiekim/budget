// Run with: bun test --preload ./scripts/test-preload.ts lib.test.ts
import { describe, test, expect } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

import { LocalDate, ViewDate } from "common";
import { getSankeyData, SankeyColumn } from "./lib";
import {
  BudgetDictionary,
  SectionDictionary,
  CategoryDictionary,
  TransactionDictionary,
  InvestmentTransactionDictionary,
  SplitTransactionDictionary,
  TransferDictionary,
  globalData,
} from "../../lib/models/Data";
import { Account } from "../../lib/models/Account";
import { Budget } from "../../lib/models/Budget";
import { Section } from "../../lib/models/Section";
import { Category } from "../../lib/models/Category";
import { Transaction } from "../../lib/models/Transaction";
import { InvestmentTransaction } from "../../lib/models/InvestmentTransaction";
import { SplitTransaction } from "../../lib/models/SplitTransaction";
import type { TransferPair } from "server";

// Fixed month so the viewDate span covers every fixture transaction.
const DATE = "2026-03-15";
const viewDate = new ViewDate("month", new LocalDate(DATE));

// Two independent budget→section→category trees so a split child can be
// re-labeled to a DIFFERENT budget than its parent (the #534 case).
const makeWorld = () => {
  const budgetA = new Budget({ name: "Budget A" });
  const sectionA = new Section({ budget_id: budgetA.id, name: "Section A" });
  const categoryA = new Category({ section_id: sectionA.id, name: "Category A" });
  const budgetB = new Budget({ name: "Budget B" });
  const sectionB = new Section({ budget_id: budgetB.id, name: "Section B" });
  const categoryB = new Category({ section_id: sectionB.id, name: "Category B" });
  const account = new Account({ account_id: "acc-1", label: { budget_id: budgetA.id } });

  const budgets = new BudgetDictionary();
  budgets.set(budgetA.id, budgetA);
  budgets.set(budgetB.id, budgetB);
  const sections = new SectionDictionary();
  sections.set(sectionA.id, sectionA);
  sections.set(sectionB.id, sectionB);
  const categories = new CategoryDictionary();
  categories.set(categoryA.id, categoryA);
  categories.set(categoryB.id, categoryB);

  return {
    budgetA, sectionA, categoryA,
    budgetB, sectionB, categoryB,
    account, budgets, sections, categories,
  };
};

const findBudget = (column: SankeyColumn, id: string) => column.find((row) => row.id === id);

const emptyInvestments = new InvestmentTransactionDictionary();
const noTransfers = new TransferDictionary();

const makeConfirmedPair = (transaction_ids: string[]): TransferDictionary => {
  const dict = new TransferDictionary();
  const pair: TransferPair = {
    pair_id: "test-pair",
    status: "confirmed",
    transactions: transaction_ids.map((id) => ({ transaction_id: id }) as never),
  };
  dict.set(pair.pair_id, pair);
  return dict;
};

describe("getSankeyData — split re-labeling (#534)", () => {
  test("split child re-labeled to a different budget is attributed to that budget, not the parent's", () => {
    const w = makeWorld();

    // Parent: 100 expense under Budget A's category, confirmed.
    const parent = new Transaction({
      account_id: w.account.id,
      transaction_id: "tx-parent",
      amount: 100,
      date: DATE,
      label: { budget_id: w.budgetA.id, category_id: w.categoryA.id, category_confidence: 1 },
    });
    const transactions = new TransactionDictionary();
    transactions.set(parent.id, parent);

    // Split child: 30 re-labeled to Budget B's category.
    const child = new SplitTransaction({
      split_transaction_id: "split-1",
      transaction_id: "tx-parent",
      account_id: w.account.id,
      amount: 30,
      label: { budget_id: w.budgetB.id, category_id: w.categoryB.id, category_confidence: 1 },
    });
    const splitTransactions = new SplitTransactionDictionary();
    splitTransactions.set(child.id, child);

    // SplitTransaction.toTransaction() resolves the parent from the module
    // `globalData` singleton, so the child leg only re-attributes when the
    // parent is present there.
    globalData.transactions.set(parent.id, parent);
    try {
      const { graphData, tableData } = getSankeyData(
        [w.account],
        transactions,
        emptyInvestments,
        splitTransactions,
        w.budgets,
        w.sections,
        w.categories,
        viewDate,
        noTransfers,
      );

      // graphData = [col1 incomeSections, col2 incomeBudgets, col3 total,
      //              col4 expenseBudgets, col5 expenseSections]
      const expenseBudgets = graphData[3];
      // Parent budget gets amount - children = 100 - 30 = 70 (was 100 before fix).
      expect(findBudget(expenseBudgets, w.budgetA.id)?.amount).toBe(70);
      // Child budget gets the re-labeled 30 (was absent before fix).
      expect(findBudget(expenseBudgets, w.budgetB.id)?.amount).toBe(30);
      // Grand total is unchanged — the money is counted once, just re-distributed.
      expect(tableData.expense).toBe(100);
    } finally {
      globalData.transactions = new TransactionDictionary();
    }
  });

  test("a plain transaction with no splits keeps its full amount on its own budget", () => {
    const w = makeWorld();
    const tx = new Transaction({
      account_id: w.account.id,
      transaction_id: "tx-1",
      amount: 80,
      date: DATE,
      label: { budget_id: w.budgetA.id, category_id: w.categoryA.id, category_confidence: 1 },
    });
    const transactions = new TransactionDictionary();
    transactions.set(tx.id, tx);

    const { graphData, tableData } = getSankeyData(
      [w.account],
      transactions,
      emptyInvestments,
      new SplitTransactionDictionary(),
      w.budgets,
      w.sections,
      w.categories,
      viewDate,
      noTransfers,
    );

    expect(findBudget(graphData[3], w.budgetA.id)?.amount).toBe(80);
    expect(tableData.expense).toBe(80);
  });

  test("a confirmed-transfer parent and its split children are both excluded", () => {
    const w = makeWorld();
    const parent = new Transaction({
      account_id: w.account.id,
      transaction_id: "tx-parent",
      amount: 100,
      date: DATE,
      label: { budget_id: w.budgetA.id, category_id: w.categoryA.id, category_confidence: 1 },
    });
    const transactions = new TransactionDictionary();
    transactions.set(parent.id, parent);

    const child = new SplitTransaction({
      split_transaction_id: "split-1",
      transaction_id: "tx-parent",
      account_id: w.account.id,
      amount: 30,
      label: { budget_id: w.budgetB.id, category_id: w.categoryB.id, category_confidence: 1 },
    });
    const splitTransactions = new SplitTransactionDictionary();
    splitTransactions.set(child.id, child);

    globalData.transactions.set(parent.id, parent);
    try {
      const { tableData } = getSankeyData(
        [w.account],
        transactions,
        emptyInvestments,
        splitTransactions,
        w.budgets,
        w.sections,
        w.categories,
        viewDate,
        makeConfirmedPair(["tx-parent"]),
      );
      // Whole family excluded: no income, no expense.
      expect(tableData.expense).toBe(0);
      expect(tableData.income).toBe(0);
    } finally {
      globalData.transactions = new TransactionDictionary();
    }
  });
});

const INV_ACCT = "inv-acc-1";
const invViewDate = new ViewDate("month", new LocalDate("2026-02-15")); // Feb 2026
const invAccount = new Account({ account_id: INV_ACCT, name: "Brokerage" });

// `quantity` is intentionally varied in sign across tests to prove the
// polarity is derived from `type`, not from the stored sign of quantity.
const mkInvestment = (
  type: InvestmentTransactionType,
  quantity: number,
  price: number,
): InvestmentTransaction =>
  new InvestmentTransaction({
    account_id: INV_ACCT,
    type,
    subtype: InvestmentTransactionSubtype.Buy,
    quantity,
    price,
    amount: price * quantity,
    date: "2026-02-15",
  });

const buildInvDicts = (itxns: InvestmentTransaction[], txns: Transaction[] = []) => {
  const investmentTransactions = new InvestmentTransactionDictionary();
  itxns.forEach((t) => investmentTransactions.set(t.id, t));
  const transactions = new TransactionDictionary();
  txns.forEach((t) => transactions.set(t.id, t));
  return {
    investmentTransactions,
    transactions,
    budgets: new BudgetDictionary(),
    sections: new SectionDictionary(),
    categories: new CategoryDictionary(),
  };
};

const runInv = (d: ReturnType<typeof buildInvDicts>) =>
  getSankeyData(
    [invAccount],
    d.transactions,
    d.investmentTransactions,
    new SplitTransactionDictionary(),
    d.budgets,
    d.sections,
    d.categories,
    invViewDate,
    noTransfers,
  );

describe("getSankeyData — investment transactions are skipped (internal moves)", () => {
  // Investment transactions are internal household moves between user-owned
  // cash and user-owned equity, not external cash flow. The cash-side
  // counterpart (the wire from checking to brokerage) is a regular
  // `transactions` row that already represents the household cash flow.
  // Counting BOTH the cash-side row and the investment-side row in Sankey
  // double-counts every dollar moved into or out of brokerage. Verified
  // against real account data: investment Buys appeared on BOTH the
  // cash-side (a brokerage-funding wire labeled under a "Transfers" budget
  // — Sankey doesn't honor budget-name semantics, so it counts as expense)
  // AND the invest-side, producing a spurious deficit that contradicted the
  // Accounts donut's balance Δ for the same month. Skipping investment txns
  // brings the two views into reconciliation modulo market appreciation.
  // See issue 564 for the cross-table transfer-detection follow-up that
  // would surface the cash-side wires as confirmed-transfer halves and let
  // Sankey attribute investment activity per-budget.
  test("a BUY is skipped (no contribution to expense or income)", () => {
    const { tableData } = runInv(buildInvDicts([mkInvestment(InvestmentTransactionType.Buy, 10, 100)]));
    expect(tableData.expense).toBe(0);
    expect(tableData.income).toBe(0);
  });

  test("a SELL is skipped (no contribution to expense or income)", () => {
    const { tableData } = runInv(buildInvDicts([mkInvestment(InvestmentTransactionType.Sell, -8, 100)]));
    expect(tableData.expense).toBe(0);
    expect(tableData.income).toBe(0);
  });

  test("mixed buys + sells contribute nothing to Sankey flow", () => {
    const { tableData, graphData } = runInv(
      buildInvDicts([
        mkInvestment(InvestmentTransactionType.Buy, 10, 100),
        mkInvestment(InvestmentTransactionType.Sell, -8, 100),
      ]),
    );
    expect(tableData.expense).toBe(0);
    expect(tableData.income).toBe(0);
    expect(graphData.every((col) => col.length === 0)).toBe(true);
  });

  test("a non-buy/sell investment type (transfer/cash/fee/dividend) is skipped — same as before", () => {
    const { tableData, graphData } = runInv(
      buildInvDicts([mkInvestment(InvestmentTransactionType.Transfer, 4875, 1)]),
    );
    expect(tableData.income).toBe(0);
    expect(tableData.expense).toBe(0);
    expect(graphData.every((col) => col.length === 0)).toBe(true);
  });

  test("regular transactions keep their convention (positive amount = expense)", () => {
    const regular = new Transaction({
      transaction_id: "t-reg",
      account_id: INV_ACCT,
      amount: 50,
      date: "2026-02-10",
      authorized_date: "2026-02-10",
    });
    const { tableData } = runInv(buildInvDicts([], [regular]));
    expect(tableData.expense).toBe(50);
    expect(tableData.income).toBe(0);
  });
});

describe("getSankeyData — budget_ids whitelist filter", () => {
  // Build the world ONCE per test so the random ids on budgets/account
  // line up across the fixture construction and the assertions.
  const setup = () => {
    const w = makeWorld();
    const txnA = new Transaction({
      account_id: w.account.id,
      transaction_id: "tx-a",
      amount: 100,
      date: DATE,
      label: { budget_id: w.budgetA.id, category_id: w.categoryA.id, category_confidence: 1 },
    });
    const txnB = new Transaction({
      account_id: w.account.id,
      transaction_id: "tx-b",
      amount: 200,
      date: DATE,
      label: { budget_id: w.budgetB.id, category_id: w.categoryB.id, category_confidence: 1 },
    });
    const transactions = new TransactionDictionary();
    transactions.set(txnA.id, txnA);
    transactions.set(txnB.id, txnB);
    const run = (budget_ids: string[]) =>
      getSankeyData(
        [w.account],
        transactions,
        emptyInvestments,
        new SplitTransactionDictionary(),
        w.budgets,
        w.sections,
        w.categories,
        viewDate,
        noTransfers,
        budget_ids,
      );
    return { w, run };
  };

  test("empty whitelist = no filter (all budgets included)", () => {
    const { w, run } = setup();
    const { tableData, graphData } = run([]);
    expect(tableData.expense).toBe(300);
    expect(findBudget(graphData[3], w.budgetA.id)?.amount).toBe(100);
    expect(findBudget(graphData[3], w.budgetB.id)?.amount).toBe(200);
  });

  test("whitelist with only Budget A excludes Budget B's transaction", () => {
    const { w, run } = setup();
    const { tableData, graphData } = run([w.budgetA.id]);
    expect(tableData.expense).toBe(100);
    expect(findBudget(graphData[3], w.budgetA.id)?.amount).toBe(100);
    expect(findBudget(graphData[3], w.budgetB.id)).toBeUndefined();
  });

  test("whitelist with only Budget B excludes Budget A's transaction", () => {
    const { w, run } = setup();
    const { tableData, graphData } = run([w.budgetB.id]);
    expect(tableData.expense).toBe(200);
    expect(findBudget(graphData[3], w.budgetB.id)?.amount).toBe(200);
    expect(findBudget(graphData[3], w.budgetA.id)).toBeUndefined();
  });

  test("whitelist with a non-matching id excludes all", () => {
    const { run } = setup();
    const { tableData, graphData } = run(["non-existent-budget-id"]);
    expect(tableData.expense).toBe(0);
    expect(tableData.income).toBe(0);
    expect(graphData.every((col) => col.length === 0)).toBe(true);
  });
});
