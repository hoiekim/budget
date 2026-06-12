// Run with: bun test --preload ./scripts/test-preload.ts lib.test.ts
import { describe, test, expect } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

import { ViewDate } from "common";
import { getSankeyData } from "./lib";
import { Account } from "../../lib/models/Account";
import { Transaction } from "../../lib/models/Transaction";
import { InvestmentTransaction } from "../../lib/models/InvestmentTransaction";
import {
  TransactionDictionary,
  InvestmentTransactionDictionary,
  BudgetDictionary,
  SectionDictionary,
  CategoryDictionary,
} from "../../lib/models/Data";

const ACCT = "acc-1";
const viewDate = new ViewDate("month", new Date(2026, 1, 1)); // Feb 2026

const account = new Account({ account_id: ACCT, name: "Brokerage" });

const mkInvestment = (
  type: InvestmentTransactionType,
  quantity: number,
  price: number,
): InvestmentTransaction =>
  new InvestmentTransaction({
    account_id: ACCT,
    type,
    subtype: InvestmentTransactionSubtype.Buy,
    quantity,
    price,
    amount: price * quantity,
    date: "2026-02-15",
  });

const buildDicts = (itxns: InvestmentTransaction[], txns: Transaction[] = []) => {
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

describe("getSankeyData — investment cash-flow polarity", () => {
  test("a BUY is cash out → counted as expense, not income", () => {
    // buy: quantity > 0, price·quantity = +1000 cash leaving the account
    const { investmentTransactions, transactions, budgets, sections, categories } = buildDicts([
      mkInvestment(InvestmentTransactionType.Buy, 10, 100),
    ]);
    const { tableData } = getSankeyData(
      [account],
      transactions,
      investmentTransactions,
      budgets,
      sections,
      categories,
      viewDate,
    );
    expect(tableData.expense).toBe(1000);
    expect(tableData.income).toBe(0);
  });

  test("a SELL is cash in → counted as income, not expense", () => {
    // sell: quantity < 0, price·quantity = -800 cash entering the account
    const { investmentTransactions, transactions, budgets, sections, categories } = buildDicts([
      mkInvestment(InvestmentTransactionType.Sell, -8, 100),
    ]);
    const { tableData } = getSankeyData(
      [account],
      transactions,
      investmentTransactions,
      budgets,
      sections,
      categories,
      viewDate,
    );
    expect(tableData.income).toBe(800);
    expect(tableData.expense).toBe(0);
  });

  test("buys and sells net to the correct Surplus/Deficit verdict", () => {
    // 1000 bought (out) vs 800 sold (in) → net 200 deficit, not a surplus
    const { investmentTransactions, transactions, budgets, sections, categories } = buildDicts([
      mkInvestment(InvestmentTransactionType.Buy, 10, 100),
      mkInvestment(InvestmentTransactionType.Sell, -8, 100),
    ]);
    const { tableData } = getSankeyData(
      [account],
      transactions,
      investmentTransactions,
      budgets,
      sections,
      categories,
      viewDate,
    );
    expect(tableData.expense).toBe(1000);
    expect(tableData.income).toBe(800);
    expect(tableData.expense - tableData.income).toBe(200); // deficit
  });

  test("regular transactions keep their convention (positive amount = expense)", () => {
    const regular = new Transaction({
      transaction_id: "t-reg",
      account_id: ACCT,
      amount: 50,
      date: "2026-02-10",
      authorized_date: "2026-02-10",
    });
    const { investmentTransactions, transactions, budgets, sections, categories } = buildDicts(
      [],
      [regular],
    );
    const { tableData } = getSankeyData(
      [account],
      transactions,
      investmentTransactions,
      budgets,
      sections,
      categories,
      viewDate,
    );
    expect(tableData.expense).toBe(50);
    expect(tableData.income).toBe(0);
  });
});
