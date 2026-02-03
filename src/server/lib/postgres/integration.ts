import { pool } from "./client";
import { MaskedUser } from "./users";
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
  JSONSplitTransaction,
  JSONTransaction,
} from "common";

export const getUpdatedDocuments = async (user: MaskedUser, startDate: Date) => {
  const { user_id } = user;
  const startIso = startDate.toISOString();

  const result = {
    accounts: [] as JSONAccount[],
    items: [] as JSONItem[],
    transactions: [] as JSONTransaction[],
    split_transactions: [] as JSONSplitTransaction[],
    investment_transactions: [] as JSONInvestmentTransaction[],
    account_snapshots: [] as JSONAccountSnapshot[],
    holding_snapshots: [] as JSONHoldingSnapshot[],
    budgets: [] as JSONBudget[],
    sections: [] as JSONSection[],
    categories: [] as JSONCategory[],
    charts: [] as JSONChart[],
  };

  // Accounts
  const accountsResult = await pool.query<{
    account_id: string;
    balances: any;
    label: any;
    graph_options: any;
    data: any;
  }>(
    `SELECT account_id, balances, label, graph_options, data FROM accounts 
     WHERE user_id = $1 AND updated >= $2`,
    [user_id, startIso]
  );
  result.accounts = accountsResult.rows.map((row) => ({
    ...row.data,
    account_id: row.account_id,
    balances: row.balances,
    label: row.label || {},
    graphOptions: row.graph_options || {},
  }));

  // Items
  const itemsResult = await pool.query<{
    item_id: string;
    data: any;
  }>(
    `SELECT item_id, data FROM items WHERE user_id = $1 AND updated >= $2`,
    [user_id, startIso]
  );
  result.items = itemsResult.rows.map((row) => ({
    ...row.data,
    item_id: row.item_id,
  }));

  // Transactions
  const transactionsResult = await pool.query<{
    transaction_id: string;
    label: any;
    data: any;
  }>(
    `SELECT transaction_id, label, data FROM transactions 
     WHERE user_id = $1 AND updated >= $2`,
    [user_id, startIso]
  );
  result.transactions = transactionsResult.rows.map((row) => ({
    ...row.data,
    transaction_id: row.transaction_id,
    label: row.label || {},
  }));

  // Split Transactions
  const splitResult = await pool.query<{
    split_transaction_id: string;
    transaction_id: string;
    account_id: string;
    amount: number;
    date: string;
    custom_name: string;
    label: any;
  }>(
    `SELECT split_transaction_id, transaction_id, account_id, amount, date, custom_name, label 
     FROM split_transactions WHERE user_id = $1 AND updated >= $2`,
    [user_id, startIso]
  );
  result.split_transactions = splitResult.rows.map((row) => ({
    split_transaction_id: row.split_transaction_id,
    transaction_id: row.transaction_id,
    account_id: row.account_id,
    amount: row.amount,
    date: row.date,
    custom_name: row.custom_name,
    label: row.label || {},
  }));

  // Investment Transactions
  const investmentResult = await pool.query<{
    investment_transaction_id: string;
    data: any;
  }>(
    `SELECT investment_transaction_id, data FROM investment_transactions 
     WHERE user_id = $1 AND updated >= $2`,
    [user_id, startIso]
  );
  result.investment_transactions = investmentResult.rows.map((row) => ({
    ...row.data,
    investment_transaction_id: row.investment_transaction_id,
  }));

  // Snapshots (account and holding)
  const snapshotsResult = await pool.query<{
    snapshot_id: string;
    user_id: string | null;
    snapshot_date: string;
    snapshot_type: string;
    data: any;
  }>(
    `SELECT snapshot_id, user_id, snapshot_date, snapshot_type, data FROM snapshots 
     WHERE user_id = $1 AND updated >= $2 AND snapshot_type IN ('account', 'holding')`,
    [user_id, startIso]
  );
  snapshotsResult.rows.forEach((row) => {
    const snapshot = {
      snapshot_id: row.snapshot_id,
      date: row.snapshot_date,
    };
    if (row.snapshot_type === "account" && row.user_id) {
      result.account_snapshots.push({
        snapshot,
        user: { user_id: row.user_id },
        account: row.data,
      });
    } else if (row.snapshot_type === "holding" && row.user_id) {
      result.holding_snapshots.push({
        snapshot,
        user: { user_id: row.user_id },
        holding: row.data,
      });
    }
  });

  // Budgets
  const budgetsResult = await pool.query<{
    budget_id: string;
    name: string;
    iso_currency_code: string;
    capacities: any;
    roll_over: boolean;
    roll_over_start_date: Date | null;
  }>(
    `SELECT budget_id, name, iso_currency_code, capacities, roll_over, roll_over_start_date 
     FROM budgets WHERE user_id = $1 AND updated >= $2`,
    [user_id, startIso]
  );
  result.budgets = budgetsResult.rows.map((row) => ({
    budget_id: row.budget_id,
    name: row.name,
    iso_currency_code: row.iso_currency_code,
    capacities: row.capacities,
    roll_over: row.roll_over,
    roll_over_start_date: row.roll_over_start_date || undefined,
  }));

  // Sections
  const sectionsResult = await pool.query<{
    section_id: string;
    budget_id: string;
    name: string;
    capacities: any;
    roll_over: boolean;
    roll_over_start_date: Date | null;
  }>(
    `SELECT section_id, budget_id, name, capacities, roll_over, roll_over_start_date 
     FROM sections WHERE user_id = $1 AND updated >= $2`,
    [user_id, startIso]
  );
  result.sections = sectionsResult.rows.map((row) => ({
    section_id: row.section_id,
    budget_id: row.budget_id,
    name: row.name,
    capacities: row.capacities,
    roll_over: row.roll_over,
    roll_over_start_date: row.roll_over_start_date || undefined,
  }));

  // Categories
  const categoriesResult = await pool.query<{
    category_id: string;
    section_id: string;
    name: string;
    capacities: any;
    roll_over: boolean;
    roll_over_start_date: Date | null;
  }>(
    `SELECT category_id, section_id, name, capacities, roll_over, roll_over_start_date 
     FROM categories WHERE user_id = $1 AND updated >= $2`,
    [user_id, startIso]
  );
  result.categories = categoriesResult.rows.map((row) => ({
    category_id: row.category_id,
    section_id: row.section_id,
    name: row.name,
    capacities: row.capacities,
    roll_over: row.roll_over,
    roll_over_start_date: row.roll_over_start_date || undefined,
  }));

  // Charts
  const chartsResult = await pool.query<{
    chart_id: string;
    name: string;
    type: string;
    configuration: string;
  }>(
    `SELECT chart_id, name, type, configuration FROM charts 
     WHERE user_id = $1 AND updated >= $2`,
    [user_id, startIso]
  );
  result.charts = chartsResult.rows.map((row) => ({
    chart_id: row.chart_id,
    name: row.name,
    type: row.type as any,
    configuration: row.configuration,
  }));

  return result;
};
