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
export type { MaskedUser } from "./users";
export { maskUser, searchUser, indexUser, deleteUser, getUserById } from "./users";

export { PostgresSessionStore } from "./session";

// Items & Institutions
export {
  upsertItems,
  getItems,
  getItem,
  getItemByAccessToken,
  deleteItems,
  deleteItem,
  updateItemCursor,
  updateItemStatus,
  getItemsByInstitution,
  getUserItem,
  searchItems,
  getAllItems,
} from "./items";

// Accounts, Holdings, Institutions, Securities
export {
  upsertAccounts,
  updateAccounts,
  getAccounts,
  getAccount,
  deleteAccounts,
  getAccountsByItem,
  searchAccountsByItemId,
  searchAccounts,
  searchAccountsById,
  upsertHoldings,
  getHoldings,
  deleteHoldings,
  searchHoldingsByAccountId,
  upsertInstitutions,
  getInstitution,
  searchInstitutionById,
  upsertSecurities,
  getSecurities,
  getSecurity,
  searchSecurities,
} from "./accounts";

// Transactions
export type { SearchTransactionsOptions, SearchSplitTransactionsOptions } from "./transactions";
export {
  upsertTransactions,
  getTransactions,
  getTransaction,
  deleteTransactions,
  searchTransactions,
  searchTransactionsByAccountId,
  upsertInvestmentTransactions,
  getInvestmentTransactions,
  deleteInvestmentTransactions,
  upsertSplitTransactions,
  getSplitTransactions,
  deleteSplitTransactions,
  deleteSplitTransactionsByTransactionId,
  searchSplitTransactions,
  createSplitTransaction,
  getOldestTransactionDate,
} from "./transactions";

// Budgets, Sections, Categories
export {
  getBudgets,
  getBudget,
  deleteBudgets,
  deleteBudget,
  searchBudgets,
  createBudget,
  updateBudget,
  getSections,
  deleteSections,
  deleteSection,
  createSection,
  updateSection,
  getCategories,
  deleteCategories,
  deleteCategory,
  createCategory,
  updateCategory,
} from "./budgets";

// Snapshots
export type { SearchSnapshotsOptions } from "./snapshots";
export {
  upsertAccountSnapshots,
  upsertSecuritySnapshots,
  upsertHoldingSnapshots,
  upsertSnapshots,
  searchSnapshots,
  getAccountSnapshots,
  getSecuritySnapshots,
  getHoldingSnapshots,
  deleteOldSnapshots,
  deleteSnapshotsByAccount,
  deleteSnapshotsByUser,
  deleteSnapshotById,
  getLatestAccountSnapshots,
  aggregateAccountSnapshots,
} from "./snapshots";

// Charts
export {
  upsertCharts,
  getCharts,
  getChart,
  deleteCharts,
  deleteChart,
  searchCharts,
  createChart,
  updateChart,
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
