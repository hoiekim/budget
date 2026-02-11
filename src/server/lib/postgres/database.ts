/**
 * Generic database query helpers for PostgreSQL.
 * Provides type-safe query building and execution utilities.
 */

import { Pool, QueryResult, QueryResultRow } from "pg";
import { NULL } from "./models/common";
import {
  Schema,
  Constraints,
  isNull,
  isUndefined,
  isDate,
  isNumber,
  isString,
  isDefined,
} from "./models/base";

// =============================================
// Constants
// =============================================

/**
 * SQL condition for excluding soft-deleted records.
 * Use this when buildSelectWithFilters isn't suitable.
 */
export const SOFT_DELETE_CONDITION = "(is_deleted IS NULL OR is_deleted = FALSE)";

// =============================================
// Types
// =============================================

/**
 * Query parameter value type - matches what pg accepts.
 */
export type ParamValue = string | number | boolean | Date | null | undefined | string[];

/**
 * Generic record type for query data.
 */
export type QueryData = Record<string, ParamValue | unknown>;

/**
 * Result of building a parameterized query.
 */
export interface PreparedQuery {
  sql: string;
  values: ParamValue[];
}

/**
 * Options for building WHERE clauses.
 */
export interface WhereOptions {
  /** Additional conditions to add */
  conditions?: string[];
  /** Starting parameter index (default: 1) */
  startIndex?: number;
  /** Whether to exclude soft-deleted records */
  excludeDeleted?: boolean;
}

/**
 * Options for update queries.
 */
export interface UpdateOptions {
  /** Additional WHERE conditions */
  additionalWhere?: { column: string; value: ParamValue };
  /** Columns to return after update */
  returning?: string[];
}

/**
 * Options for upsert queries.
 */
export interface UpsertOptions {
  /** Columns to update on conflict (if empty, DO NOTHING) */
  updateColumns?: string[];
  /** Columns to return after upsert */
  returning?: string[];
}

// =============================================
// Table Creation
// =============================================

/**
 * Generates a CREATE TABLE IF NOT EXISTS statement from a schema.
 */
export function buildCreateTable(
  tableName: string,
  schema: Schema<Record<string, unknown>>,
  constraints: Constraints = []
): string {
  const columnDefs = Object.entries(schema).map(
    ([column, definition]) => `${column} ${definition}`
  );

  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      ${[...columnDefs, ...constraints].join(",\n      ")}
    )
  `.trim();
}

/**
 * Generates a CREATE INDEX IF NOT EXISTS statement.
 */
export function buildCreateIndex(
  tableName: string,
  column: string,
  indexName?: string
): string {
  const name = indexName || `idx_${tableName}_${column}`;
  return `CREATE INDEX IF NOT EXISTS ${name} ON ${tableName}(${column})`;
}

// =============================================
// Value Preparation
// =============================================

/**
 * Prepares a value for use in a WHERE clause (for inline SQL, not parameterized).
 * Returns undefined for values that shouldn't be included in queries.
 */
export function prepareValue(value: unknown): string | number | undefined {
  if (isString(value)) return `'${value.replace(/'/g, "''")}'`;
  if (isNumber(value)) return value;
  if (isDate(value)) return `'${value.toISOString()}'`;
  if (isNull(value)) return NULL;
  return undefined;
}

/**
 * Prepares a value for parameterized query binding.
 * Converts Date objects to ISO strings.
 */
export function prepareParamValue(value: ParamValue): ParamValue {
  if (isDate(value)) return value.toISOString();
  return value;
}

// =============================================
// WHERE Clause Building
// =============================================

/**
 * Builds a dynamic WHERE clause from a partial object.
 * Returns the WHERE string and parameter values for parameterized queries.
 */
export function prepareQuery(
  data: QueryData,
  options: WhereOptions = {}
): PreparedQuery {
  const { conditions: additionalConditions = [], startIndex = 1, excludeDeleted = true } = options;
  
  const conditions: string[] = [...additionalConditions];
  const values: ParamValue[] = [];
  let paramIndex = startIndex;

  for (const [key, value] of Object.entries(data)) {
    if (isUndefined(value)) continue;
    
    if (isNull(value)) {
      conditions.push(`${key} IS NULL`);
    } else {
      conditions.push(`${key} = $${paramIndex}`);
      values.push(prepareParamValue(value as ParamValue));
      paramIndex++;
    }
  }

  if (excludeDeleted) {
    conditions.push("(is_deleted IS NULL OR is_deleted = FALSE)");
  }

  const sql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { sql, values };
}

// =============================================
// INSERT Query Building
// =============================================

/**
 * Builds an INSERT query from data.
 */
export function buildInsert(
  tableName: string,
  data: Record<string, ParamValue>,
  returning?: string[]
): PreparedQuery {
  const columns: string[] = ["updated"];
  const placeholders: string[] = ["CURRENT_TIMESTAMP"];
  const values: ParamValue[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    if (isUndefined(value)) continue;
    columns.push(key);
    placeholders.push(`$${paramIndex}`);
    values.push(prepareParamValue(value));
    paramIndex++;
  }

  let sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;

  if (returning && returning.length > 0) {
    sql += ` RETURNING ${returning.join(", ")}`;
  }

  return { sql, values };
}

// =============================================
// UPDATE Query Building
// =============================================

/**
 * Builds a dynamic UPDATE query from a partial object.
 * Returns null if there are no fields to update.
 */
export function buildUpdate(
  tableName: string,
  primaryKey: string,
  primaryKeyValue: ParamValue,
  data: QueryData,
  options: UpdateOptions = {}
): PreparedQuery | null {
  const setClauses: string[] = ["updated = CURRENT_TIMESTAMP"];
  const values: ParamValue[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    if (key === "raw") continue;
    if (isUndefined(value)) continue;
    setClauses.push(`${key} = $${paramIndex}`);
    values.push(prepareParamValue(value as ParamValue));
    paramIndex++;
  }

  // If only 'updated' timestamp would be set, skip the update
  if (setClauses.length === 1) {
    return null;
  }

  // Add primary key value
  values.push(primaryKeyValue);
  const pkParam = paramIndex;
  paramIndex++;

  let sql = `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${primaryKey} = $${pkParam}`;

  // Add additional WHERE clause if provided
  if (options.additionalWhere) {
    values.push(options.additionalWhere.value);
    sql += ` AND ${options.additionalWhere.column} = $${paramIndex}`;
    paramIndex++;
  }

  // Add RETURNING clause if provided
  if (options.returning && options.returning.length > 0) {
    sql += ` RETURNING ${options.returning.join(", ")}`;
  }

  return { sql, values };
}

// =============================================
// UPSERT Query Building
// =============================================

/**
 * Builds an INSERT ... ON CONFLICT query (upsert).
 */
export function buildUpsert(
  tableName: string,
  primaryKey: string,
  data: QueryData,
  options: UpsertOptions = {}
): PreparedQuery {
  const { updateColumns = [], returning = [primaryKey] } = options;

  const columns: string[] = ["updated"];
  const placeholders: string[] = ["CURRENT_TIMESTAMP"];
  const values: ParamValue[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(data)) {
    if (isUndefined(value)) continue;
    columns.push(key);
    placeholders.push(`$${paramIndex}`);
    values.push(prepareParamValue(value as ParamValue));
    paramIndex++;
  }

  let sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;

  if (updateColumns.length > 0) {
    const updateClauses = updateColumns
      .filter((col) => col !== primaryKey)
      .map((col) => `${col} = EXCLUDED.${col}`);
    updateClauses.push("updated = CURRENT_TIMESTAMP");
    sql += ` ON CONFLICT (${primaryKey}) DO UPDATE SET ${updateClauses.join(", ")}`;
  } else {
    sql += ` ON CONFLICT (${primaryKey}) DO NOTHING`;
  }

  if (returning.length > 0) {
    sql += ` RETURNING ${returning.join(", ")}`;
  }

  return { sql, values };
}

// =============================================
// SELECT Query Building
// =============================================

/**
 * Builds a SELECT query with optional conditions.
 */
export function buildSelect(
  tableName: string,
  columns: string[] | "*",
  whereClause?: PreparedQuery,
  orderBy?: string,
  limit?: number,
  offset?: number
): PreparedQuery {
  const columnList = columns === "*" ? "*" : columns.join(", ");
  let sql = `SELECT ${columnList} FROM ${tableName}`;
  const values: ParamValue[] = whereClause?.values || [];

  if (whereClause?.sql) {
    sql += ` ${whereClause.sql}`;
  }

  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }

  if (limit !== undefined) {
    values.push(limit);
    sql += ` LIMIT $${values.length}`;
  }

  if (offset !== undefined) {
    values.push(offset);
    sql += ` OFFSET $${values.length}`;
  }

  return { sql, values };
}

// =============================================
// DELETE Query Building
// =============================================

/**
 * Builds a soft-delete UPDATE query.
 */
export function buildSoftDelete(
  tableName: string,
  primaryKey: string,
  primaryKeyValue: ParamValue,
  additionalWhere?: { column: string; value: ParamValue }
): PreparedQuery {
  const values: ParamValue[] = [primaryKeyValue];
  let sql = `UPDATE ${tableName} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${primaryKey} = $1`;

  if (additionalWhere) {
    values.push(additionalWhere.value);
    sql += ` AND ${additionalWhere.column} = $${values.length}`;
  }

  sql += ` RETURNING ${primaryKey}`;

  return { sql, values };
}

/**
 * Builds a soft-delete UPDATE query for multiple IDs.
 */
export function buildBulkSoftDelete(
  tableName: string,
  primaryKey: string,
  primaryKeyValues: ParamValue[],
  additionalWhere?: { column: string; value: ParamValue }
): PreparedQuery {
  if (primaryKeyValues.length === 0) {
    return { sql: "", values: [] };
  }

  const values: ParamValue[] = [];
  let paramIndex = 1;

  // Add additional where value first if present
  if (additionalWhere) {
    values.push(additionalWhere.value);
    paramIndex++;
  }

  // Add primary key values
  const placeholders = primaryKeyValues.map((val) => {
    values.push(val);
    return `$${paramIndex++}`;
  });

  let sql = `UPDATE ${tableName} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${primaryKey} IN (${placeholders.join(", ")})`;

  if (additionalWhere) {
    sql += ` AND ${additionalWhere.column} = $1`;
  }

  sql += ` RETURNING ${primaryKey}`;

  return { sql, values };
}

// =============================================
// Filter Options for Search Queries
// =============================================

/**
 * Common filter options for search queries.
 */
export interface SearchFilters {
  /** User ID for ownership filtering */
  user_id?: string;
  /** Primary key value */
  primaryKey?: { column: string; value: ParamValue };
  /** Additional equality filters */
  filters?: QueryData;
  /** IN clause filters (column IN (values)) */
  inFilters?: Record<string, ParamValue[]>;
  /** Date range filters */
  dateRange?: {
    column: string;
    start?: string | Date;
    end?: string | Date;
  };
  /** Exclude soft-deleted records */
  excludeDeleted?: boolean;
  /** ORDER BY clause */
  orderBy?: string;
  /** LIMIT value */
  limit?: number;
  /** OFFSET value */
  offset?: number;
}

/**
 * Builds a SELECT query with dynamic filters from a partial object.
 * This is the generic query builder for repository search functions.
 */
export function buildSelectWithFilters(
  tableName: string,
  columns: string[] | "*",
  options: SearchFilters = {}
): PreparedQuery {
  const {
    user_id,
    primaryKey,
    filters = {},
    inFilters = {},
    dateRange,
    excludeDeleted = true,
    orderBy,
    limit,
    offset,
  } = options;

  const conditions: string[] = [];
  const values: ParamValue[] = [];
  let paramIndex = 1;

  // User ownership filter
  if (user_id) {
    conditions.push(`user_id = $${paramIndex++}`);
    values.push(user_id);
  }

  // Primary key filter
  if (primaryKey) {
    conditions.push(`${primaryKey.column} = $${paramIndex++}`);
    values.push(primaryKey.value);
  }

  // Equality filters from partial object
  for (const [key, value] of Object.entries(filters)) {
    if (isUndefined(value)) continue;
    if (isNull(value)) {
      conditions.push(`${key} IS NULL`);
    } else {
      conditions.push(`${key} = $${paramIndex++}`);
      values.push(prepareParamValue(value as ParamValue));
    }
  }

  // IN clause filters
  for (const [column, valueArray] of Object.entries(inFilters)) {
    if (!valueArray || valueArray.length === 0) continue;
    const placeholders = valueArray.map((_, i) => `$${paramIndex + i}`).join(", ");
    conditions.push(`${column} IN (${placeholders})`);
    values.push(...valueArray);
    paramIndex += valueArray.length;
  }

  // Date range filter
  if (dateRange) {
    if (dateRange.start) {
      conditions.push(`${dateRange.column} >= $${paramIndex++}`);
      values.push(
        isDate(dateRange.start)
          ? dateRange.start.toISOString().split("T")[0]
          : dateRange.start
      );
    }
    if (dateRange.end) {
      conditions.push(`${dateRange.column} <= $${paramIndex++}`);
      values.push(
        isDate(dateRange.end)
          ? dateRange.end.toISOString().split("T")[0]
          : dateRange.end
      );
    }
  }

  // Soft delete filter
  if (excludeDeleted) {
    conditions.push("(is_deleted IS NULL OR is_deleted = FALSE)");
  }

  // Build query
  const columnList = columns === "*" ? "*" : columns.join(", ");
  let sql = `SELECT ${columnList} FROM ${tableName}`;

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }

  if (limit !== undefined) {
    sql += ` LIMIT $${paramIndex++}`;
    values.push(limit);
  }

  if (offset !== undefined) {
    sql += ` OFFSET $${paramIndex}`;
    values.push(offset);
  }

  return { sql, values };
}

// =============================================
// Query Execution Helpers
// =============================================

/**
 * Executes a query and returns all rows.
 */
export async function query<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  values?: ParamValue[]
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, values);
}

/**
 * Executes a query and returns the first row or null.
 */
export async function queryOne<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  values?: ParamValue[]
): Promise<T | null> {
  const result = await pool.query<T>(sql, values);
  return result.rows[0] || null;
}

/**
 * Executes a select query with filters and returns rows.
 */
export async function selectWithFilters<T extends QueryResultRow>(
  pool: Pool,
  tableName: string,
  columns: string[] | "*",
  options: SearchFilters = {}
): Promise<T[]> {
  const { sql, values } = buildSelectWithFilters(tableName, columns, options);
  const result = await pool.query<T>(sql, values);
  return result.rows;
}

/**
 * Result type for upsert/update operations.
 */
export interface UpsertResult {
  update: { _id: string };
  status: number;
}

/**
 * Creates a successful upsert result.
 */
export function successResult(id: string, rowCount: number | null): UpsertResult {
  return {
    update: { _id: id },
    status: rowCount ? 200 : 404,
  };
}

/**
 * Creates an error upsert result.
 */
export function errorResult(id: string): UpsertResult {
  return {
    update: { _id: id },
    status: 500,
  };
}

/**
 * Creates a no-change result.
 */
export function noChangeResult(id: string): UpsertResult {
  return {
    update: { _id: id },
    status: 304,
  };
}
