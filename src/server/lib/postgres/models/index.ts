/**
 * Models index - re-exports all models and schemas.
 */

// Common constants and base types
export * from "./common";
export * from "./base";

// User model
export {
  UserModel,
  userSchema,
  userConstraints,
  userColumns,
} from "./user";
export type { UserRow, MaskedUser, User } from "./user";

// Session model
export {
  SessionModel,
  sessionSchema,
  sessionColumns,
} from "./session";
export type { SessionRow } from "./session";

// Item model
export {
  ItemModel,
  itemSchema,
  itemConstraints,
  itemColumns,
  itemIndexes,
} from "./item";
export type { ItemRow } from "./item";

// Account-related models
export {
  // Account
  AccountModel,
  accountSchema,
  accountConstraints,
  accountColumns,
  accountIndexes,
  // Holding
  HoldingModel,
  holdingSchema,
  holdingConstraints,
  holdingColumns,
  holdingIndexes,
  // Institution
  InstitutionModel,
  institutionSchema,
  institutionColumns,
  // Security
  SecurityModel,
  securitySchema,
  securityColumns,
} from "./account";
export type {
  AccountRow,
  HoldingRow,
  InstitutionRow,
  SecurityRow,
} from "./account";

// Transaction-related models
export {
  // Transaction
  TransactionModel,
  transactionSchema,
  transactionConstraints,
  transactionColumns,
  transactionIndexes,
  // Investment Transaction
  InvestmentTransactionModel,
  investmentTransactionSchema,
  investmentTransactionConstraints,
  investmentTransactionColumns,
  investmentTransactionIndexes,
  // Split Transaction
  SplitTransactionModel,
  splitTransactionSchema,
  splitTransactionConstraints,
  splitTransactionColumns,
  splitTransactionIndexes,
} from "./transaction";
export type {
  TransactionRow,
  InvestmentTransactionRow,
  SplitTransactionRow,
} from "./transaction";

// Budget-related models
export {
  // Budget
  BudgetModel,
  budgetSchema,
  budgetConstraints,
  budgetColumns,
  budgetIndexes,
  // Section
  SectionModel,
  sectionSchema,
  sectionConstraints,
  sectionColumns,
  sectionIndexes,
  // Category
  CategoryModel,
  categorySchema,
  categoryConstraints,
  categoryColumns,
  categoryIndexes,
} from "./budget";
export type {
  BudgetRow,
  SectionRow,
  CategoryRow,
} from "./budget";

// Snapshot model
export {
  SnapshotModel,
  snapshotSchema,
  snapshotConstraints,
  snapshotColumns,
  snapshotIndexes,
  isAccountSnapshot,
  isSecuritySnapshot,
  isHoldingSnapshot,
} from "./snapshot";
export type { SnapshotRow, SnapshotType } from "./snapshot";

// Chart model
export {
  ChartModel,
  chartSchema,
  chartConstraints,
  chartColumns,
  chartIndexes,
} from "./chart";
export type { ChartRow } from "./chart";
