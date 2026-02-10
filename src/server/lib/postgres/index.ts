/**
 * PostgreSQL Database Module
 *
 * Provides data access layer for the budget application.
 * Uses flattened column structure for partial updates (no JSONB for nested objects
 * except for array fields like capacities).
 *
 * Architecture:
 * - models/: Schema definitions and model classes with validation
 * - repositories/: CRUD operations using models
 * - database.ts: Generic query helpers
 * - client.ts: Connection pool
 * - initialize.ts: Table creation
 */

// Client (connection pool)
export { pool } from "./client";

// Initialization
export { initializeIndex, version, index } from "./initialize";

// Database query helpers
export {
  buildCreateTable,
  buildCreateIndex,
  buildInsert,
  buildUpdate,
  buildUpsert,
  buildSelect,
  buildSoftDelete,
  buildBulkSoftDelete,
  prepareQuery,
  prepareValue,
  prepareParamValue,
  query,
  queryOne,
  successResult,
  errorResult,
  noChangeResult,
  type PreparedQuery,
  type WhereOptions,
  type UpdateOptions,
  type UpsertOptions,
  type ParamValue,
  type QueryData,
  type UpsertResult,
} from "./database";

// Models - schemas and model classes
export * from "./models";

// Repositories - all CRUD operations
export * from "./repositories";

// Legacy utils (for backward compatibility during migration)
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
