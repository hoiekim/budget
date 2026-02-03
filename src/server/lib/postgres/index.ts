/**
 * PostgreSQL Database Module
 * 
 * Provides data access layer for the budget application, replacing Elasticsearch.
 * Uses flattened column structure for partial updates (no JSONB for nested objects
 * except for array fields like capacities).
 */

export { pool } from "./client";
export { initializeIndex, version, index } from "./initialize";

// Users & Sessions
export {
  MaskedUser,
  searchUser,
  indexUser,
  deleteUser,
  getUserById,
} from "./users";

export {
  getSession,
  setSession,
  destroySession,
} from "./session";

// Items & Institutions
export {
  upsertItems,
  getItems,
  getItem,
  getItemByAccessToken,
  deleteItems,
  updateItemCursor,
  updateItemStatus,
  getItemsByInstitution,
} from "./items";

// Accounts, Holdings, Institutions, Securities
export {
  upsertAccounts,
  getAccounts,
  getAccount,
  deleteAccounts,
  getAccountsByItem,
  upsertHoldings,
  getHoldings,
  upsertInstitutions,
  getInstitution,
  upsertSecurities,
  getSecurities,
  getSecurity,
} from "./accounts";

// Transactions
export {
  upsertTransactions,
  getTransactions,
  getTransaction,
  deleteTransactions,
  upsertInvestmentTransactions,
  getInvestmentTransactions,
  upsertSplitTransactions,
  getSplitTransactions,
  deleteSplitTransactions,
} from "./transactions";

// Budgets, Sections, Categories
export {
  upsertBudgets,
  getBudgets,
  getBudget,
  deleteBudgets,
  upsertSections,
  getSections,
  deleteSections,
  upsertCategories,
  getCategories,
  deleteCategories,
} from "./budgets";

// Snapshots
export {
  upsertAccountSnapshots,
  upsertSecuritySnapshots,
  upsertHoldingSnapshots,
  getAccountSnapshots,
  getSecuritySnapshots,
  getHoldingSnapshots,
  deleteOldSnapshots,
  getLatestAccountSnapshots,
  aggregateAccountSnapshots,
} from "./snapshots";

// Charts
export {
  upsertCharts,
  getCharts,
  getChart,
  deleteCharts,
} from "./charts";

// Utilities
export {
  flattenObject,
  unflattenObject,
  toSnakeCase,
  toCamelCase,
  buildUpdateQuery,
  buildUpsertQuery,
  rowToDocument,
  documentToRow,
} from "./utils";
