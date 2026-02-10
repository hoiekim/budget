/**
 * Repositories index - re-exports all repository functions.
 */

// User repository
export {
  maskUser,
  indexUser,
  searchUser,
  updateUser,
  getUserById,
  deleteUser,
} from "./users";
export type { IndexUserInput, PartialUser } from "./users";

// Re-export MaskedUser and User from models for convenience
export type { MaskedUser, User } from "../models";

// Session repository
export { PostgresSessionStore } from "./session";

// Item repository
export {
  getItems,
  getItem,
  getAllItems,
  searchItems,
  getItemByAccessToken,
  getItemsByInstitution,
  getUserItem,
  upsertItems,
  updateItemCursor,
  updateItemStatus,
  deleteItem,
  deleteItems,
} from "./items";
export type { PartialItem } from "./items";

// Account repository
export {
  // Accounts
  getAccounts,
  getAccount,
  getAccountsByItem,
  searchAccountsByItemId,
  searchAccounts,
  searchAccountsById,
  upsertAccounts,
  updateAccounts,
  deleteAccounts,
  // Holdings
  getHoldings,
  searchHoldingsByAccountId,
  upsertHoldings,
  deleteHoldings,
  // Institutions
  getInstitution,
  searchInstitutionById,
  upsertInstitutions,
  // Securities
  getSecurity,
  getSecurities,
  searchSecurities,
  upsertSecurities,
} from "./accounts";
export type { PartialAccount } from "./accounts";

// Transaction repository
export {
  // Transactions
  getTransactions,
  getTransaction,
  getOldestTransactionDate,
  upsertTransactions,
  updateTransactions,
  deleteTransactions,
  searchTransactionsByAccountId,
  searchTransactions,
  // Investment transactions
  getInvestmentTransactions,
  upsertInvestmentTransactions,
  updateInvestmentTransactions,
  deleteInvestmentTransactions,
  // Split transactions
  getSplitTransactions,
  searchSplitTransactions,
  createSplitTransaction,
  updateSplitTransactions,
  deleteSplitTransactions,
  deleteSplitTransactionsByTransactionId,
} from "./transactions";
export type {
  SearchTransactionsOptions,
  PartialTransaction,
  SearchSplitTransactionsOptions,
  PartialSplitTransaction,
} from "./transactions";

// Budget repository
export {
  // Budgets
  getBudgets,
  getBudget,
  searchBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
  deleteBudgets,
  // Sections
  getSections,
  createSection,
  updateSection,
  deleteSection,
  deleteSections,
  // Categories
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  deleteCategories,
} from "./budgets";

// Snapshot repository
export {
  searchSnapshots,
  getAccountSnapshots,
  getSecuritySnapshots,
  getHoldingSnapshots,
  getLatestAccountSnapshots,
  upsertAccountSnapshots,
  upsertSecuritySnapshots,
  upsertHoldingSnapshots,
  upsertSnapshots,
  deleteOldSnapshots,
  deleteSnapshotsByAccount,
  deleteSnapshotsByUser,
  deleteSnapshotById,
  aggregateAccountSnapshots,
} from "./snapshots";
export type {
  SearchSnapshotsOptions,
  AccountSnapshot,
  SecuritySnapshot,
  HoldingSnapshot,
} from "./snapshots";

// Chart repository
export {
  getCharts,
  getChart,
  searchCharts,
  createChart,
  updateChart,
  deleteChart,
  deleteCharts,
} from "./charts";
