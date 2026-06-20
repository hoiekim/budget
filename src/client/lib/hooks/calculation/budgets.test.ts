import { describe, test, expect } from "bun:test";
import { LocalDate, MAX_FLOAT } from "common";
import { getBudgetData, getCapacityData } from "./budgets";
import {
  AccountDictionary,
  BudgetDictionary,
  SectionDictionary,
  CategoryDictionary,
  TransactionDictionary,
  SplitTransactionDictionary,
  TransferDictionary,
} from "../../models/Data";
import type { TransferPair } from "server";

// Helper: build a TransferDictionary with the given transaction ids treated
// as halves of a single CONFIRMED pair. Mirrors what `data.transfers`
// holds after `fetchTransfers` populates it from `/api/transfers`.
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
import { Account } from "../../models/Account";
import { Budget } from "../../models/Budget";
import { Section } from "../../models/Section";
import { Category } from "../../models/Category";
import { Transaction } from "../../models/Transaction";
import { SplitTransaction } from "../../models/SplitTransaction";

// Fixed month so write-key and read-key agree (getBudgetData keys by
// getYearMonthString(transactionDate)).
const DATE = "2026-03-15";
const readDate = new LocalDate(DATE);

// Build a minimal budget → section → category hierarchy wired to one account.
const makeWorld = () => {
  const budget = new Budget({ name: "Budget" });
  const section = new Section({ budget_id: budget.id, name: "Section" });
  const category = new Category({ section_id: section.id, name: "Category" });
  const account = new Account({ account_id: "acc-1", label: { budget_id: budget.id } });

  const budgets = new BudgetDictionary();
  budgets.set(budget.id, budget);
  const sections = new SectionDictionary();
  sections.set(section.id, section);
  const categories = new CategoryDictionary();
  categories.set(category.id, category);
  const accounts = new AccountDictionary();
  accounts.set(account.id, account);

  return { budget, section, category, account, budgets, sections, categories, accounts };
};

const makeTx = (
  world: ReturnType<typeof makeWorld>,
  amount: number,
  label: { budget_id?: string | null; category_id?: string | null; category_confidence?: number | null },
  overrides: Partial<Transaction> = {},
) => {
  const tx = new Transaction({
    account_id: world.account.id,
    transaction_id: overrides.transaction_id || "tx-1",
    amount,
    date: DATE,
    label,
    ...overrides,
  });
  const transactions = new TransactionDictionary();
  transactions.set(tx.id, tx);
  return { tx, transactions };
};

const empty = {
  transactions: new TransactionDictionary(),
  splits: new SplitTransactionDictionary(),
  transfers: new TransferDictionary(),
};

describe("getBudgetData — confidence-gate bucketing", () => {
  test("empty dictionaries produce empty budget data", () => {
    const w = makeWorld();
    const { budgetData } = getBudgetData(
      new TransactionDictionary(),
      new SplitTransactionDictionary(),
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      empty.transfers,
    );
    expect(budgetData.size).toBe(0);
  });

  test("transaction on a hidden account is skipped entirely", () => {
    const w = makeWorld();
    w.account.hide = true;
    const { transactions } = makeTx(w, 100, {
      budget_id: w.budget.id,
      category_id: w.category.id,
      category_confidence: 1,
    });
    const { budgetData } = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      empty.transfers,
    );
    expect(budgetData.size).toBe(0);
  });

  test("confirmed (confidence=1 + category_id) → sorted bucket on category, section, budget", () => {
    const w = makeWorld();
    const { transactions } = makeTx(w, 100, {
      budget_id: w.budget.id,
      category_id: w.category.id,
      category_confidence: 1,
    });
    const { budgetData } = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      empty.transfers,
    );
    expect(budgetData.get(w.category.id, readDate).sorted_amount).toBe(100);
    expect(budgetData.get(w.section.id, readDate).sorted_amount).toBe(100);
    expect(budgetData.get(w.budget.id, readDate).sorted_amount).toBe(100);
    // Nothing landed in the unsorted bucket.
    expect(budgetData.get(w.budget.id, readDate).unsorted_amount).toBe(0);
    expect(budgetData.get(w.budget.id, readDate).number_of_unsorted_items).toBe(0);
  });

  // The #333 invariant: a rejected suggestion keeps its category_id (so the
  // merchant signal can learn the negative) but MUST still count as unsorted —
  // never attributed to the rejected category.
  test("rejected (confidence=0 + category_id set) → unsorted bucket, NOT the category", () => {
    const w = makeWorld();
    const { transactions } = makeTx(w, 40, {
      budget_id: w.budget.id,
      category_id: w.category.id,
      category_confidence: 0,
    });
    const { budgetData } = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      empty.transfers,
    );
    expect(budgetData.get(w.budget.id, readDate).unsorted_amount).toBe(40);
    expect(budgetData.get(w.budget.id, readDate).number_of_unsorted_items).toBe(1);
    expect(budgetData.get(w.category.id, readDate).sorted_amount).toBe(0);
  });

  test("auto-suggested but unreviewed (0 < confidence < 1) → unsorted bucket", () => {
    const w = makeWorld();
    const { transactions } = makeTx(w, 25, {
      budget_id: w.budget.id,
      category_id: w.category.id,
      category_confidence: 0.8,
    });
    const { budgetData } = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      empty.transfers,
    );
    expect(budgetData.get(w.budget.id, readDate).unsorted_amount).toBe(25);
    expect(budgetData.get(w.category.id, readDate).sorted_amount).toBe(0);
  });

  test("genuinely unlabeled (null confidence) → unsorted bucket via account's budget", () => {
    const w = makeWorld();
    const { transactions } = makeTx(w, 10, {
      budget_id: null,
      category_id: null,
      category_confidence: null,
    });
    const { budgetData } = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      empty.transfers,
    );
    expect(budgetData.get(w.budget.id, readDate).unsorted_amount).toBe(10);
    expect(budgetData.get(w.budget.id, readDate).number_of_unsorted_items).toBe(1);
  });

  test("malformed (confidence=1 but null category_id) → unsorted (guard at the isConfirmed gate)", () => {
    const w = makeWorld();
    const { transactions } = makeTx(w, 70, {
      budget_id: w.budget.id,
      category_id: null,
      category_confidence: 1,
    });
    const { budgetData } = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      empty.transfers,
    );
    expect(budgetData.get(w.budget.id, readDate).unsorted_amount).toBe(70);
  });
});

describe("getBudgetData — split transactions", () => {
  test("parent amount is reduced by its split children (amountAfterSplit)", () => {
    const w = makeWorld();
    const parent = new Transaction({
      account_id: w.account.id,
      transaction_id: "tx-parent",
      amount: 100,
      date: DATE,
      label: { budget_id: w.budget.id, category_id: w.category.id, category_confidence: 1 },
    });
    const transactions = new TransactionDictionary();
    transactions.set(parent.id, parent);

    const split = new SplitTransaction({
      split_transaction_id: "split-1",
      transaction_id: "tx-parent",
      account_id: w.account.id,
      amount: 30,
      label: { budget_id: w.budget.id, category_id: w.category.id, category_confidence: 1 },
    });
    const splitTransactions = new SplitTransactionDictionary();
    splitTransactions.set(split.id, split);

    const { budgetData, transactionFamilies } = getBudgetData(
      transactions,
      splitTransactions,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      empty.transfers,
    );

    // The parent contributes amount - childrenTotal = 100 - 30 = 70.
    // (The split is ALSO re-processed as a synthetic transaction, but
    // SplitTransaction.toTransaction() resolves the parent from the module
    // `globalData` singleton — empty in an isolated unit test — so the
    // synthetic row is dropped here. The +30 leg is covered by E2E, not this
    // unit. This test pins the amountAfterSplit subtraction.)
    expect(transactionFamilies.getChildrenAmountTotal("tx-parent")).toBe(30);
    expect(budgetData.get(w.category.id, readDate).sorted_amount).toBe(70);
  });
});

describe("getCapacityData — hierarchy aggregation", () => {
  test("section capacity aggregates into the budget's children_total", () => {
    const budget = new Budget({ name: "B" });
    const section = new Section({ budget_id: budget.id, capacities: [{ month: 100 }] });
    const budgets = new BudgetDictionary();
    budgets.set(budget.id, budget);
    const sections = new SectionDictionary();
    sections.set(section.id, section);

    const cap = getCapacityData(budgets, sections, new CategoryDictionary());
    const budgetCapId = budget.getActiveCapacity(new Date(0)).id;
    expect(cap.get(budgetCapId).children_total).toBe(100);
  });

  test("category capacity aggregates into section children_total + budget grand_children_total", () => {
    const budget = new Budget({ name: "B" });
    const section = new Section({ budget_id: budget.id, capacities: [{ month: 100 }] });
    const category = new Category({ section_id: section.id, capacities: [{ month: 30 }] });
    const budgets = new BudgetDictionary();
    budgets.set(budget.id, budget);
    const sections = new SectionDictionary();
    sections.set(section.id, section);
    const categories = new CategoryDictionary();
    categories.set(category.id, category);

    const cap = getCapacityData(budgets, sections, categories);
    const sectionCapId = section.getActiveCapacity(new Date(0)).id;
    const budgetCapId = budget.getActiveCapacity(new Date(0)).id;
    expect(cap.get(sectionCapId).children_total).toBe(30);
    expect(cap.get(budgetCapId).grand_children_total).toBe(30);
  });

  test("MAX_FLOAT capacity overrides (not adds) the children_total", () => {
    const budget = new Budget({ name: "B" });
    const section = new Section({ budget_id: budget.id, capacities: [{ month: MAX_FLOAT }] });
    const budgets = new BudgetDictionary();
    budgets.set(budget.id, budget);
    const sections = new SectionDictionary();
    sections.set(section.id, section);

    const cap = getCapacityData(budgets, sections, new CategoryDictionary());
    const budgetCapId = budget.getActiveCapacity(new Date(0)).id;
    expect(cap.get(budgetCapId).children_total).toBe(MAX_FLOAT);
  });

  test("negative MAX_FLOAT capacity overrides to negative", () => {
    const budget = new Budget({ name: "B" });
    const section = new Section({ budget_id: budget.id, capacities: [{ month: -MAX_FLOAT }] });
    const budgets = new BudgetDictionary();
    budgets.set(budget.id, budget);
    const sections = new SectionDictionary();
    sections.set(section.id, section);

    const cap = getCapacityData(budgets, sections, new CategoryDictionary());
    const budgetCapId = budget.getActiveCapacity(new Date(0)).id;
    expect(cap.get(budgetCapId).children_total).toBe(-MAX_FLOAT);
  });
});

describe("getBudgetData — confirmed-transfer exclusion", () => {
  test("transactions in a confirmed transfer pair are skipped from all budget rollups", () => {
    const w = makeWorld();

    // Two confirmed-spending transactions, one of which is a transfer half.
    const { transactions: t1 } = makeTx(w, 250, {
      budget_id: w.budget.id,
      category_id: w.category.id,
      category_confidence: 1,
    }, { transaction_id: "tx-spend" });
    const { transactions: t2 } = makeTx(w, 5100, {
      budget_id: w.budget.id,
      category_id: w.category.id,
      category_confidence: 1,
    }, { transaction_id: "tx-transfer-half" });

    const transactions = new TransactionDictionary();
    t1.forEach((v, k) => transactions.set(k, v));
    t2.forEach((v, k) => transactions.set(k, v));

    // Without the set: both transactions count → category total = 5350.
    const baseline = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      empty.transfers,
    );
    expect(baseline.budgetData.get(w.category.id, readDate).sorted_amount).toBe(5350);

    // With tx-transfer-half flagged: only the $250 spend lands.
    const withTransfer = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      makeConfirmedPair(["tx-transfer-half", "tx-transfer-half-2"]),
    );
    expect(withTransfer.budgetData.get(w.category.id, readDate).sorted_amount).toBe(250);
    expect(withTransfer.budgetData.get(w.section.id, readDate).sorted_amount).toBe(250);
    expect(withTransfer.budgetData.get(w.budget.id, readDate).sorted_amount).toBe(250);
  });

  test("an unsorted transaction in a confirmed pair is also skipped (unsorted bucket)", () => {
    const w = makeWorld();
    // Unsorted transaction — no category_id / confidence — would normally
    // land in the unsorted bucket. As a transfer half it should not.
    const { transactions } = makeTx(w, 5100, {
      budget_id: w.budget.id,
      category_id: null,
      category_confidence: null,
    }, { transaction_id: "tx-transfer-unsorted" });

    const withTransfer = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      makeConfirmedPair(["tx-transfer-unsorted", "tx-transfer-unsorted-2"]),
    );
    // Budget bucket exists only if any transaction landed in it. With the
    // sole transaction filtered out, the budget id should not be tracked.
    expect(withTransfer.budgetData.size).toBe(0);
  });

  test("splits of a confirmed-transfer parent are also skipped (reviewoie #528 round 1)", () => {
    const w = makeWorld();

    // Parent transaction is a transfer half (in the set).
    const { transactions } = makeTx(w, 100, {
      budget_id: w.budget.id,
      category_id: w.category.id,
      category_confidence: 1,
    }, { transaction_id: "tx-transfer-parent" });

    // Two splits of that parent — they inherit the parent's
    // transaction_id reference but their own split_transaction_id. If
    // the guard only checks the synthetic Transaction's id (which is
    // overridden to split.id by `SplitTransaction.toTransaction()`),
    // these will leak into Coffee's sorted_amount. The correct shape
    // is to gate on parent's transaction_id at the split pass.
    const splitA = new SplitTransaction({
      split_transaction_id: "split-A",
      transaction_id: "tx-transfer-parent",
      account_id: w.account.id,
      amount: 30,
      date: DATE,
      label: { budget_id: w.budget.id, category_id: w.category.id, category_confidence: 1 },
    });
    const splitB = new SplitTransaction({
      split_transaction_id: "split-B",
      transaction_id: "tx-transfer-parent",
      account_id: w.account.id,
      amount: 20,
      date: DATE,
      label: { budget_id: w.budget.id, category_id: w.category.id, category_confidence: 1 },
    });
    const splits = new SplitTransactionDictionary();
    splits.set(splitA.id, splitA);
    splits.set(splitB.id, splitB);

    const withTransfer = getBudgetData(
      transactions,
      splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      makeConfirmedPair(["tx-transfer-parent", "tx-transfer-parent-2"]),
    );
    // No data should land — parent skipped, both splits skipped.
    expect(withTransfer.budgetData.size).toBe(0);
  });

  test("an empty TransferDictionary behaves exactly like the no-arg call (backward compat)", () => {
    const w = makeWorld();
    const { transactions } = makeTx(w, 100, {
      budget_id: w.budget.id,
      category_id: w.category.id,
      category_confidence: 1,
    });

    const noArg = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      empty.transfers,
    );
    const emptySet = getBudgetData(
      transactions,
      empty.splits,
      w.accounts,
      w.budgets,
      w.sections,
      w.categories,
      new TransferDictionary(),
    );
    expect(emptySet.budgetData.get(w.category.id, readDate).sorted_amount).toBe(
      noArg.budgetData.get(w.category.id, readDate).sorted_amount,
    );
  });
});
