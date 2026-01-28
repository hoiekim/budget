import { MaskedUser } from "server";
import { client } from "./client";
import { index } from ".";
import {
  Account,
  AccountSnapshot,
  Budget,
  Category,
  Chart,
  Holding,
  HoldingSnapshot,
  InvestmentTransaction,
  Item,
  JSONBudget,
  JSONCategory,
  JSONChart,
  JSONSection,
  Section,
  Snapshot,
  SplitTransaction,
  Transaction,
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
    account?: Account;
    holding?: Holding;
    item?: Item;
    transaction?: Transaction;
    split_transaction?: SplitTransaction;
    investment_transaction?: InvestmentTransaction;
    snapshot?: Snapshot;
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
    accounts: Account[];
    items: Item[];
    transactions: Transaction[];
    split_transactions: SplitTransaction[];
    investment_transactions: InvestmentTransaction[];
    account_snapshots: AccountSnapshot[];
    holding_snapshots: HoldingSnapshot[];
    budgets: Budget[];
    sections: Section[];
    categories: Category[];
    charts: Chart[];
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

  response.hits.hits.forEach(({ _source, _id }) => {
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
      if (account) result.account_snapshots.push(new AccountSnapshot({ user, snapshot, account }));
      if (holding) result.holding_snapshots.push(new HoldingSnapshot({ user, snapshot, holding }));
    } else if (account) {
      result.accounts.push(new Account(account));
    }
    if (item) result.items.push(new Item(item));
    if (transaction) result.transactions.push(new Transaction(transaction));
    if (split_transaction) result.split_transactions.push(new SplitTransaction(split_transaction));
    if (investment_transaction) {
      result.investment_transactions.push(new InvestmentTransaction(investment_transaction));
    }
    if (budget) result.budgets.push(new Budget(budget));
    if (section) result.sections.push(new Section(section));
    if (category) result.categories.push(new Category(category));
    if (chart) result.charts.push(new Chart(chart));
  });

  return result;
};
