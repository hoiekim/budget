/**
 * Cross-cutting name constants that both server and client reference. Kept
 * in `common/` (rather than `server/lib/postgres/models/common.ts` where
 * they used to live) so the client — e.g. the SSE receiver hook — can
 * import the same identifiers the server emits with.
 */

/** Every database table. Table names are lowercase snake_case and mirror
 *  the actual CREATE TABLE identifiers. Reference at call sites via
 *  `TableName.Accounts` so a typo is a compile error. The exported
 *  UPPER_SNAKE string constants below are back-compat aliases for the
 *  existing server callers that already import them by name. */
export enum TableName {
  Users = "users",
  Sessions = "sessions",
  Items = "items",
  Institutions = "institutions",
  Accounts = "accounts",
  Holdings = "holdings",
  Securities = "securities",
  Transactions = "transactions",
  InvestmentTransactions = "investment_transactions",
  SplitTransactions = "split_transactions",
  TransactionPairs = "transaction_pairs",
  Budgets = "budgets",
  Sections = "sections",
  Categories = "categories",
  Snapshots = "snapshots",
  Charts = "charts",
  ApiKeys = "api_keys",
  RejectedCategories = "rejected_categories",
}

export const USERS = TableName.Users;
export const SESSIONS = TableName.Sessions;
export const ITEMS = TableName.Items;
export const INSTITUTIONS = TableName.Institutions;
export const ACCOUNTS = TableName.Accounts;
export const HOLDINGS = TableName.Holdings;
export const SECURITIES = TableName.Securities;
export const TRANSACTIONS = TableName.Transactions;
export const INVESTMENT_TRANSACTIONS = TableName.InvestmentTransactions;
export const SPLIT_TRANSACTIONS = TableName.SplitTransactions;
export const TRANSACTION_PAIRS = TableName.TransactionPairs;
export const BUDGETS = TableName.Budgets;
export const SECTIONS = TableName.Sections;
export const CATEGORIES = TableName.Categories;
export const SNAPSHOTS = TableName.Snapshots;
export const CHARTS = TableName.Charts;
export const API_KEYS = TableName.ApiKeys;
export const REJECTED_CATEGORIES = TableName.RejectedCategories;

/**
 * Id prefix of the holding snapshots the client derives from a holding's
 * transactions. They exist only in memory; every stored holding snapshot is a
 * position someone entered.
 */
export const DERIVED_HOLDING_SNAPSHOT_PREFIX = "derived-holding-";

/** Id prefix of investment transactions imported from a plan statement. */
export const PLAN_STATEMENT_ID_PREFIX = "plan-";

export const BUDGET_NAME_REQUIRED_MESSAGE = "Budget name cannot be empty.";
