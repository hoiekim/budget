/**
 * Generic database query helpers for PostgreSQL.
 */

import { isNull, isUndefined, isDate } from "common";
import type { SqlExecutor, SqlQueryResult } from "./client";
import { Schema, Constraints } from "./models/base";

export const SOFT_DELETE_CONDITION = "(is_deleted IS NULL OR is_deleted = FALSE)";

/**
 * Filter sentinel — pass as a filter value to express `<column> IS NOT NULL`.
 * Symmetrical to passing `null`, which expresses `<column> IS NULL`.
 *
 *   table.query({ merchant_name: IS_NOT_NULL });
 */
export const IS_NOT_NULL = Symbol("IS_NOT_NULL");

/** The SQL function listing a user and everyone in their sharing group (see `models/sharing.ts`). */
export const SHARING_USER_IDS = "sharing_user_ids";

/**
 * Filter sentinel — pass as a filter value on an owner column to match the
 * rows of that user and of everyone they share data with.
 *
 *   table.query({ user_id: sharedWith(user) });
 */
export class SharedWith {
  constructor(readonly user_id: string) {}
}

export const sharedWith = (user: { user_id: string }): SharedWith => new SharedWith(user.user_id);

/** The predicate a `SharedWith` filter becomes, for SQL written by hand. */
export const sharedWithSql = (column: string, placeholder: string): string =>
  `${column} = ANY(${SHARING_USER_IDS}(${placeholder}))`;

/**
 * The advisory-lock key a user's sharing group serializes on: the same for
 * every member, and the user's own id while they share with nobody.
 */
export const sharingLockKeySql = (placeholder: string): string =>
  `(SELECT min(member::text) FROM unnest(${SHARING_USER_IDS}(${placeholder})) member)`;

/**
 * The advisory-lock key of sharing membership as a whole. Joining or leaving
 * a group holds it exclusively; work that reads a group and must not see it
 * change midway holds it shared, and takes it before any lock keyed on the
 * group (`sharingLockKeySql`), so the two never wait on each other in turn.
 */
export const SHARING_MEMBERSHIP_LOCK_KEY = "hashtext('sharing')";

const equalityCondition = (column: string, value: unknown, paramIndex: number): string =>
  value instanceof SharedWith
    ? sharedWithSql(column, `$${paramIndex}`)
    : `${column} = $${paramIndex}`;

const equalityParam = (value: unknown): ParamValue =>
  value instanceof SharedWith ? value.user_id : prepareParamValue(value as ParamValue);

// JSONB columns take objects/arrays as values (Bun.sql encodes a plain
// object or array as JSON for json/jsonb columns; a pre-stringified value
// would be stored as a JSON string instead of the object — see
// models/budget.ts#fromJSON and repositories/charts.ts).
export type ParamValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | string[]
  | Record<string, unknown>
  | unknown[];

export type QueryData = Record<string, ParamValue | unknown>;

export interface PreparedQuery {
  sql: string;
  values: ParamValue[];
}

export interface WhereOptions {
  conditions?: string[];
  startIndex?: number;
  excludeDeleted?: boolean;
}

/**
 * Extra equality (or null) condition to AND into an UPDATE's WHERE.
 *
 * Value semantics mirror `prepareQuery` so callers can express IS NULL /
 * IS NOT NULL without dropping to raw SQL:
 *   - `value: null` → `<column> IS NULL`
 *   - `value: IS_NOT_NULL` → `<column> IS NOT NULL`
 *   - `sharedWith(user)` → `<column> = ANY(sharing_user_ids($N))`
 *   - anything else → `<column> = $N`
 */
export type AdditionalWhere = {
  column: string;
  value: ParamValue | typeof IS_NOT_NULL | SharedWith;
};

export interface UpdateOptions {
  additionalWhere?: AdditionalWhere | AdditionalWhere[];
  returning?: string[];
  /**
   * Restrict the UPDATE to live rows, the way `prepareQuery` already does.
   * Defaults to true; pass `false` explicitly to write to a soft-deleted row.
   */
  excludeDeleted?: boolean;
}

export interface UpsertOptions {
  updateColumns?: string[];
  returning?: string[];
}

export function buildCreateTable(
  tableName: string,
  schema: Schema,
  constraints: Constraints = [],
): string {
  const columnDefs = Object.entries(schema).map(
    ([column, definition]) => `${column} ${definition}`,
  );

  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      ${[...columnDefs, ...constraints].join(",\n      ")}
    )
  `.trim();
}

export function buildCreateIndex(
  tableName: string,
  column: string | string[],
  indexName?: string,
  { unique = false, where }: { unique?: boolean; where?: string } = {},
): string {
  const columns = Array.isArray(column) ? column : [column];
  const name = indexName || `idx_${tableName}_${columns.join("_")}`;
  const kind = unique ? "UNIQUE INDEX" : "INDEX";
  const predicate = where ? ` WHERE ${where}` : "";
  return `CREATE ${kind} IF NOT EXISTS ${name} ON ${tableName}(${columns.join(", ")})${predicate}`;
}

/**
 * The keys more than one row shares, among the rows a unique index on `key`
 * with predicate `where` would cover: what stops that index from being
 * created. Rows with a NULL in the key are left out, since a unique index
 * never counts them as equal.
 */
export function buildSelectDuplicateKeys(
  tableName: string,
  key: string | string[],
  where?: string,
): string {
  const keys = Array.isArray(key) ? key : [key];
  const list = keys.join(", ");
  const conditions = [...keys.map((k) => `${k} IS NOT NULL`), ...(where ? [`(${where})`] : [])];
  return (
    `SELECT ${list} FROM ${tableName} WHERE ${conditions.join(" AND ")}` +
    ` GROUP BY ${list} HAVING COUNT(*) > 1 ORDER BY ${list}`
  );
}

export function prepareParamValue(value: ParamValue): ParamValue {
  if (isDate(value)) return value.toISOString();
  // `sharedWith(user)` names several owners, which a row can't have.
  if ((value as unknown) instanceof SharedWith) {
    throw new Error("sharedWith() scopes a query to a sharing group; it is not a value to store");
  }
  return value;
}

export function prepareQuery(data: QueryData, options: WhereOptions = {}): PreparedQuery {
  const { conditions: additionalConditions = [], startIndex = 1, excludeDeleted = true } = options;

  const conditions: string[] = [...additionalConditions];
  const values: ParamValue[] = [];
  let paramIndex = startIndex;

  for (const [key, value] of Object.entries(data)) {
    if (isUndefined(value)) continue;

    if (value === IS_NOT_NULL) {
      conditions.push(`${key} IS NOT NULL`);
    } else if (isNull(value)) {
      conditions.push(`${key} IS NULL`);
    } else {
      conditions.push(equalityCondition(key, value, paramIndex));
      values.push(equalityParam(value));
      paramIndex++;
    }
  }

  if (excludeDeleted) {
    conditions.push(SOFT_DELETE_CONDITION);
  }

  const sql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { sql, values };
}

export function buildInsert(
  tableName: string,
  data: Record<string, ParamValue>,
  returning?: string[],
  options: { onConflictDoNothing?: boolean } = {},
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

  if (options.onConflictDoNothing) sql += " ON CONFLICT DO NOTHING";

  if (returning && returning.length > 0) {
    sql += ` RETURNING ${returning.join(", ")}`;
  }

  return { sql, values };
}

export function buildUpdate(
  tableName: string,
  primaryKey: string,
  primaryKeyValue: ParamValue,
  data: QueryData,
  options: UpdateOptions = {},
): PreparedQuery | null {
  // Updates exclude soft-deleted rows by default, the way reads already do
  // (`buildFilterClauses` defaults `excludeDeleted` to true). Including
  // tombstones is the thing a caller has to ask for, with an explicit
  // `excludeDeleted: false`.
  const { excludeDeleted = true } = options;
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

  if (setClauses.length === 1) {
    return null;
  }

  values.push(primaryKeyValue);
  const pkParam = paramIndex;
  paramIndex++;

  let sql = `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${primaryKey} = $${pkParam}`;

  if (options.additionalWhere) {
    const extras = Array.isArray(options.additionalWhere)
      ? options.additionalWhere
      : [options.additionalWhere];
    for (const { column, value } of extras) {
      if (value === IS_NOT_NULL) {
        sql += ` AND ${column} IS NOT NULL`;
      } else if (isNull(value)) {
        sql += ` AND ${column} IS NULL`;
      } else {
        values.push(value instanceof SharedWith ? value.user_id : value);
        sql += ` AND ${equalityCondition(column, value, paramIndex)}`;
        paramIndex++;
      }
    }
  }

  if (excludeDeleted) {
    sql += ` AND ${SOFT_DELETE_CONDITION}`;
  }

  if (options.returning && options.returning.length > 0) {
    sql += ` RETURNING ${options.returning.join(", ")}`;
  }

  return { sql, values };
}

export function buildUpsert(
  tableName: string,
  primaryKey: string,
  data: QueryData,
  options: UpsertOptions = {},
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

export function buildUpsertMany(
  tableName: string,
  primaryKey: string,
  rows: QueryData[],
  options: UpsertOptions = {},
): PreparedQuery | null {
  if (!rows.length) return null;
  const { updateColumns = [], returning = [primaryKey] } = options;

  // Every tuple of a multi-row INSERT has to name the same columns, and a
  // column present in one row but absent from another would be inserted as its
  // default and then propagated by `EXCLUDED.col`, clearing the stored value.
  // Callers group rows that share a defined-column set; the first row names it.
  const columns = Object.keys(rows[0]).filter((key) => !isUndefined(rows[0][key]));

  const values: ParamValue[] = [];
  let paramIndex = 1;
  const tuples = rows.map((row) => {
    const placeholders = ["CURRENT_TIMESTAMP"];
    for (const column of columns) {
      placeholders.push(`$${paramIndex}`);
      values.push(prepareParamValue(row[column] as ParamValue));
      paramIndex++;
    }
    return `(${placeholders.join(", ")})`;
  });

  let sql = `INSERT INTO ${tableName} (${["updated", ...columns].join(", ")}) VALUES ${tuples.join(", ")}`;

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

export function buildSelect(
  tableName: string,
  columns: string[] | "*",
  whereClause?: PreparedQuery,
  orderBy?: string,
  limit?: number,
  offset?: number,
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

export function buildSoftDelete(
  tableName: string,
  primaryKey: string,
  primaryKeyValue: ParamValue,
  additionalWhere?: { column: string; value: ParamValue | SharedWith },
): PreparedQuery {
  const values: ParamValue[] = [primaryKeyValue];
  let sql = `UPDATE ${tableName} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${primaryKey} = $1`;

  if (additionalWhere) {
    const { column, value } = additionalWhere;
    values.push(value instanceof SharedWith ? value.user_id : value);
    sql += ` AND ${equalityCondition(column, value, values.length)}`;
  }

  sql += ` RETURNING ${primaryKey}`;

  return { sql, values };
}

export interface SearchFilters {
  user_id?: string | SharedWith;
  primaryKey?: { column: string; value: ParamValue };
  filters?: QueryData;
  inFilters?: Record<string, ParamValue[]>;
  dateRange?: {
    column: string;
    start?: string | Date;
    end?: string | Date;
  };
  excludeDeleted?: boolean;
  /** Only rows whose `column` equals `value` in any letter case: `lower(column) = lower($N)`. */
  equalsIgnoringCase?: { column: string; value: string };
  /** Keyset pagination: only rows whose `column` sorts after `value`. */
  after?: { column: string; value: ParamValue };
  orderBy?: string;
  limit?: number;
  offset?: number;
}

export function buildSelectWithFilters(
  tableName: string,
  columns: string[] | "*",
  options: SearchFilters = {},
): PreparedQuery {
  const {
    user_id,
    primaryKey,
    filters = {},
    inFilters = {},
    equalsIgnoringCase,
    dateRange,
    excludeDeleted = true,
    after,
    orderBy,
    limit,
    offset,
  } = options;

  const conditions: string[] = [];
  const values: ParamValue[] = [];
  let paramIndex = 1;

  if (user_id) {
    conditions.push(equalityCondition("user_id", user_id, paramIndex++));
    values.push(equalityParam(user_id));
  }

  if (primaryKey) {
    conditions.push(`${primaryKey.column} = $${paramIndex++}`);
    values.push(primaryKey.value);
  }

  for (const [key, value] of Object.entries(filters)) {
    if (isUndefined(value)) continue;
    if (value === IS_NOT_NULL) {
      conditions.push(`${key} IS NOT NULL`);
    } else if (isNull(value)) {
      conditions.push(`${key} IS NULL`);
    } else {
      conditions.push(equalityCondition(key, value, paramIndex++));
      values.push(equalityParam(value));
    }
  }

  for (const [column, valueArray] of Object.entries(inFilters)) {
    if (!valueArray || valueArray.length === 0) continue;
    const placeholders = valueArray.map((_, i) => `$${paramIndex + i}`).join(", ");
    conditions.push(`${column} IN (${placeholders})`);
    values.push(...valueArray);
    paramIndex += valueArray.length;
  }

  if (equalsIgnoringCase) {
    conditions.push(`lower(${equalsIgnoringCase.column}) = lower($${paramIndex++})`);
    values.push(equalsIgnoringCase.value);
  }

  if (dateRange) {
    if (dateRange.start) {
      conditions.push(`${dateRange.column} >= $${paramIndex++}`);
      values.push(
        isDate(dateRange.start) ? dateRange.start.toISOString().split("T")[0] : dateRange.start,
      );
    }
    if (dateRange.end) {
      conditions.push(`${dateRange.column} <= $${paramIndex++}`);
      values.push(
        isDate(dateRange.end) ? dateRange.end.toISOString().split("T")[0] : dateRange.end,
      );
    }
  }

  if (excludeDeleted) {
    conditions.push(SOFT_DELETE_CONDITION);
  }

  if (after) {
    conditions.push(`${after.column} > $${paramIndex++}`);
    values.push(after.value);
  }

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

export async function query<T>(
  pool: SqlExecutor,
  sql: string,
  values?: ParamValue[],
): Promise<SqlQueryResult<T>> {
  return pool.query<T>(sql, values);
}

export async function queryOne<T>(
  pool: SqlExecutor,
  sql: string,
  values?: ParamValue[],
): Promise<T | null> {
  const result = await pool.query<T>(sql, values);
  return result.rows[0] || null;
}

export interface UpsertResult {
  update: { _id: string };
  status: number;
}

export function successResult(id: string, rowCount: number | null): UpsertResult {
  return {
    update: { _id: id },
    status: rowCount ? 200 : 404,
  };
}

export function errorResult(id: string): UpsertResult {
  return {
    update: { _id: id },
    status: 500,
  };
}

/** The write was refused because the request named a row the caller can't use. */
export function refusedResult(id: string): UpsertResult {
  return {
    update: { _id: id },
    status: 422,
  };
}

export function noChangeResult(id: string): UpsertResult {
  return {
    update: { _id: id },
    status: 304,
  };
}

