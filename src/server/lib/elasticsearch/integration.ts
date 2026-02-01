import { MaskedUser } from "server";
import { client } from "./client";
import { index } from ".";
import {
  JSONAccount,
  JSONAccountSnapshot,
  JSONHolding,
  JSONHoldingSnapshot,
  JSONInvestmentTransaction,
  JSONItem,
  JSONBudget,
  JSONCategory,
  JSONChart,
  JSONSection,
  JSONSnapshot,
  JSONSplitTransaction,
  JSONTransaction,
} from "common";

export const getUpdatedDocuments = async (user: MaskedUser, startDate: Date) => {
  const { user_id } = user;
  const types = [
    "accounts",
    "items",
    "transactions",
    "splitTransactions",
    "investmentTransactions",
    "accountSnapshots",
    "holdingSnapshots",
    "budgets",
    "sections",
    "categories",
    "charts",
  ];

  const typeFilters = types.map((type) => ({ term: { type } }));

  const filter: any[] = [
    { term: { "user.user_id": user_id } },
    { bool: { should: typeFilters } },
    { range: { updated: { gte: startDate.toISOString() } } },
  ];

  // TODO: All of these are actually JSON object.
  type Response = {
    account?: JSONAccount;
    holding?: JSONHolding;
    item?: JSONItem;
    transaction?: JSONTransaction;
    split_transaction?: JSONSplitTransaction;
    investment_transaction?: JSONInvestmentTransaction;
    snapshot?: JSONSnapshot;
    user?: { user_id: string };
    budget?: JSONBudget;
    section?: JSONSection;
    category?: JSONCategory;
    chart?: JSONChart;
  };

  const response = await client.search<Response>({
    index,
    from: 0,
    size: 10000,
    query: { bool: { filter } },
  });

  type Result = {
    accounts: JSONAccount[];
    items: JSONItem[];
    transactions: JSONTransaction[];
    split_transactions: JSONSplitTransaction[];
    investment_transactions: JSONInvestmentTransaction[];
    account_snapshots: JSONAccountSnapshot[];
    holding_snapshots: JSONHoldingSnapshot[];
    budgets: JSONBudget[];
    sections: JSONSection[];
    categories: JSONCategory[];
    charts: JSONChart[];
  };

  const result: Result = {
    accounts: [],
    items: [],
    transactions: [],
    split_transactions: [],
    investment_transactions: [],
    account_snapshots: [],
    holding_snapshots: [],
    budgets: [],
    sections: [],
    categories: [],
    charts: [],
  };

  response.hits.hits.forEach(({ _source }) => {
    if (!_source) return;
    const {
      account,
      holding,
      item,
      transaction,
      split_transaction,
      investment_transaction,
      snapshot,
      user,
      budget,
      section,
      category,
      chart,
    } = _source;
    if (!user || user.user_id !== user_id) return;
    if (snapshot) {
      if (account) result.account_snapshots.push({ user, snapshot, account });
      if (holding) result.holding_snapshots.push({ user, snapshot, holding });
    } else if (account) {
      result.accounts.push(account);
    }
    if (item) result.items.push(item);
    if (transaction) result.transactions.push(transaction);
    if (split_transaction) result.split_transactions.push(split_transaction);
    if (investment_transaction) {
      result.investment_transactions.push(investment_transaction);
    }
    if (budget) result.budgets.push(budget);
    if (section) result.sections.push(section);
    if (category) result.categories.push(category);
    if (chart) result.charts.push(chart);
  });

  return result;
};
