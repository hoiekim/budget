// Run with: bun test --preload ./scripts/test-preload.ts sort.test.ts
import { describe, test, expect } from "bun:test";
import { AccountType, InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

import { formatSortValue, getSearchPool, type OrderingContext } from "./sort";
import { applySortings } from "../../lib/hooks/sorter";
import { Account } from "../../lib/models/Account";
import { Budget } from "../../lib/models/Budget";
import { Category } from "../../lib/models/Category";
import { Section } from "../../lib/models/Section";
import { Institution } from "../../lib/models/miscellaneous";
import { Transaction } from "../../lib/models/Transaction";
import { SplitTransaction } from "../../lib/models/SplitTransaction";
import { InvestmentTransaction } from "../../lib/models/InvestmentTransaction";
import {
  AccountDictionary,
  BudgetDictionary,
  CategoryDictionary,
  InstitutionDictionary,
  SectionDictionary,
  TransactionDictionary,
} from "../../lib/models/Data";
import { TransactionFamilies } from "../../lib/models/Calculations";

const ACCOUNT_ID = "acc-brokerage";

const makeCtx = (): OrderingContext => {
  const accounts = new AccountDictionary();
  accounts.set(
    ACCOUNT_ID,
    new Account({
      account_id: ACCOUNT_ID,
      name: "Brokerage",
      custom_name: "Retirement Brokerage",
      institution_id: "ins-1",
      type: AccountType.Investment,
    }),
  );

  const institutions = new InstitutionDictionary();
  institutions.set("ins-1", new Institution({ institution_id: "ins-1", name: "Fidelity" }));

  const budgets = new BudgetDictionary();
  budgets.set("bud-1", new Budget({ budget_id: "bud-1", name: "Household" }));

  const sections = new SectionDictionary();
  sections.set("sec-1", new Section({ section_id: "sec-1", budget_id: "bud-1", name: "Utilities" }));

  const categories = new CategoryDictionary();
  categories.set(
    "cat-1",
    new Category({ category_id: "cat-1", section_id: "sec-1", name: "Electricity" }),
  );

  return {
    accounts,
    institutions,
    budgets,
    sections,
    categories,
    transactions: new TransactionDictionary(),
    transactionFamilies: new TransactionFamilies(),
  };
};

const makeInvestment = (
  id: string,
  date: string,
  amount: number,
  name = "Unknown",
): InvestmentTransaction =>
  new InvestmentTransaction({
    investment_transaction_id: id,
    account_id: ACCOUNT_ID,
    date,
    amount,
    name,
    type: InvestmentTransactionType.Buy,
    subtype: InvestmentTransactionSubtype.Buy,
  });

const idsOf = (rows: { id: string }[]) => rows.map((e) => e.id);

describe("formatSortValue — investment rows", () => {
  test("date resolves to a Date so the comparison is not discarded", () => {
    const ctx = makeCtx();
    const value = formatSortValue(makeInvestment("i-1", "2026-02-17", -100), "date", ctx);
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).getFullYear()).toBe(2026);
    expect((value as Date).getMonth()).toBe(1);
    expect((value as Date).getDate()).toBe(17);
  });

  test("amount resolves to a number, including a zero-amount manual row", () => {
    const ctx = makeCtx();
    expect(formatSortValue(makeInvestment("i-1", "2026-02-17", -250.5), "amount", ctx)).toBe(-250.5);
    // Falling through to the generic `|| e.id` tail here would hand the
    // comparator a string and silently drop the row out of the ordering.
    expect(formatSortValue(makeInvestment("i-2", "2026-02-17", 0), "amount", ctx)).toBe(0);
  });

  test("account resolves to the rendered name, preferring custom_name", () => {
    const ctx = makeCtx();
    expect(formatSortValue(makeInvestment("i-1", "2026-02-17", -1), "account", ctx)).toBe(
      "Retirement Brokerage",
    );
  });

  test("institution resolves through the account", () => {
    const ctx = makeCtx();
    expect(formatSortValue(makeInvestment("i-1", "2026-02-17", -1), "institution", ctx)).toBe(
      "Fidelity",
    );
  });
});

describe("ordering — investment rows through the real sorter", () => {
  // Ids deliberately ordered so a plain `investment_transaction_id`
  // comparison disagrees with every column ordering asserted below —
  // that opaque-id order is exactly what the page rendered before #676.
  const rows = () => [
    makeInvestment("o-1", "2026-02-03", -300),
    makeInvestment("a-1", "2026-02-17", -100),
    makeInvestment("D-1", "2026-02-04", -500),
    makeInvestment("1-1", "2026-02-13", -200),
  ];

  test("date descending — the default the header advertises", () => {
    const sorted = applySortings(rows(), new Map([["date", "descending"]]), (e, key) =>
      formatSortValue(e, key, makeCtx()),
    );
    expect(idsOf(sorted)).toEqual(["a-1", "1-1", "D-1", "o-1"]);
  });

  test("date ascending", () => {
    const sorted = applySortings(rows(), new Map([["date", "ascending"]]), (e, key) =>
      formatSortValue(e, key, makeCtx()),
    );
    expect(idsOf(sorted)).toEqual(["o-1", "D-1", "1-1", "a-1"]);
  });

  test("amount descending then ascending give opposite orders", () => {
    const desc = applySortings(rows(), new Map([["amount", "descending"]]), (e, key) =>
      formatSortValue(e, key, makeCtx()),
    );
    expect(idsOf(desc)).toEqual(["a-1", "1-1", "o-1", "D-1"]);

    const asc = applySortings(rows(), new Map([["amount", "ascending"]]), (e, key) =>
      formatSortValue(e, key, makeCtx()),
    );
    expect(idsOf(asc)).toEqual(["D-1", "o-1", "1-1", "a-1"]);
  });
});

describe("getSearchPool", () => {
  test("an InvestmentTransaction contributes its name and its account context", () => {
    const ctx = makeCtx();
    const row = makeInvestment("i-1", "2026-02-17", -100, "VANGUARD 500 IDX");
    row.label.budget_id = "bud-1";
    row.label.category_id = "cat-1";

    const pool = getSearchPool(row, ctx);
    expect(pool).toContain("VANGUARD 500 IDX");
    expect(pool).toContain("Retirement Brokerage");
    expect(pool).toContain("Fidelity");
    expect(pool).toContain("Household");
    expect(pool).toContain("Utilities");
    expect(pool).toContain("Electricity");
  });

  test("a SplitTransaction contributes its parent's name and merchant name", () => {
    const ctx = makeCtx();
    ctx.transactions.set(
      "txn-1",
      new Transaction({
        transaction_id: "txn-1",
        account_id: ACCOUNT_ID,
        name: "SQ *BLUE BOTTLE",
        merchant_name: "Blue Bottle Coffee",
      }),
    );

    const split = new SplitTransaction({
      split_transaction_id: "split-1",
      transaction_id: "txn-1",
      account_id: ACCOUNT_ID,
      amount: -4,
      label: { category_id: "cat-1" },
    });

    const pool = getSearchPool(split, ctx);
    expect(pool).toContain("SQ *BLUE BOTTLE");
    expect(pool).toContain("Blue Bottle Coffee");
    expect(pool).toContain("Electricity");
  });

  test("a SplitTransaction whose parent is missing scores on its own context, not a throw", () => {
    const ctx = makeCtx();
    const split = new SplitTransaction({
      split_transaction_id: "split-1",
      transaction_id: "gone",
      account_id: ACCOUNT_ID,
      amount: -4,
    });

    expect(() => getSearchPool(split, ctx)).not.toThrow();
    expect(getSearchPool(split, ctx)).toContain("Retirement Brokerage");
  });

  test("a whole Transaction keeps the pool it always had", () => {
    const ctx = makeCtx();
    const txn = new Transaction({
      transaction_id: "txn-1",
      account_id: ACCOUNT_ID,
      name: "SQ *BLUE BOTTLE",
      merchant_name: "Blue Bottle Coffee",
      label: { budget_id: "bud-1", category_id: "cat-1" },
    });

    expect(getSearchPool(txn, ctx)).toEqual([
      "SQ *BLUE BOTTLE",
      "Blue Bottle Coffee",
      "Retirement Brokerage",
      "Fidelity",
      "Household",
      "Utilities",
      "Electricity",
    ]);
  });
});
