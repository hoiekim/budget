import { PoolClient } from "pg";
import { pool } from "../client";
import {
  buildSelectWithFilters,
  buildInsert,
  buildUpdate,
  buildUpsert,
  buildSoftDelete,
  AdditionalWhere,
  ParamValue,
  QueryData,
  SearchFilters,
} from "../database";

/** Query executor - either pool or a transaction client */
export type QueryExecutor = typeof pool | PoolClient;

export class ModelValidationError extends Error {
  public readonly errors: string[];

  constructor(modelName: string, errors: string[]) {
    super(`${modelName} validation failed:\n${errors.join("\n")}`);
    this.name = "ModelValidationError";
    this.errors = errors;
  }
}

export type ColumnDefinition = string;

export type Schema = { [k: string]: ColumnDefinition };

export type Constraints = string[];

export type RowValueType = string | number | Date | boolean | null | Object;

export type IndexDefinition = { column: string } | { columns: string[] };

export type PropertyChecker<T> = {
  [K in keyof T]: (value: unknown) => boolean;
};

export function validateObject<T extends Record<string, unknown>>(
  input: unknown,
  checker: PropertyChecker<T>,
  skip: (keyof T)[] = [],
): string[] {
  if (typeof input !== "object" || input === null) {
    return [`Input is not a valid object: ${String(input)}`];
  }

  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  for (const [key, check] of Object.entries(checker)) {
    if (skip.includes(key as keyof T)) continue;
    if (!check) continue;
    const value = obj[key];
    if (!check(value)) {
      errors.push(`${key}: ${JSON.stringify(value)} (${typeof value})`);
    }
  }

  return errors;
}

export abstract class Model<TJSON, TSchema extends Schema> {
  abstract toJSON(): TJSON;

  constructor(data: unknown, typeChecker: PropertyChecker<TSchema>) {
    // asserts type
    const errors = validateObject(data, typeChecker);
    if (errors.length > 0) throw new ModelValidationError(this.constructor.name, errors);
    // assigns value
    Object.keys(typeChecker).forEach((k) => {
      (this as Record<string, unknown>)[k] = (data as TSchema)[k];
    });
  }
}

export interface ModelClass<TJSON, TModel extends Model<TJSON, Schema>> {
  new (data: unknown): TModel;
}

export abstract class Table<
  TJSON,
  TSchema extends Schema,
  TModel extends Model<TJSON, TSchema> = Model<TJSON, TSchema>,
> {
  abstract readonly name: string;
  abstract readonly primaryKey: string;
  abstract readonly schema: TSchema;
  abstract readonly constraints: Constraints;
  abstract readonly indexes: IndexDefinition[];
  abstract readonly ModelClass: ModelClass<TJSON, TModel>;
  abstract readonly supportsSoftDelete: boolean;

  /**
   * Composite-PK tables (declared via `constraints: ["PRIMARY KEY (a, b)"]`)
   * cannot use the single-column built-in helpers — every method below
   * treats `this.primaryKey` as the row key. Calling `upsert`, `update`,
   * `softDelete`, `queryByIds`, `hardDelete`, etc. would silently corrupt
   * rows by matching on the wrong constraint. This guard throws at runtime
   * so a Stage-2 contributor can't make that mistake.
   *
   * Composite-PK tables must use raw `pool.query` writes in their
   * repository layer (mirroring what `repositories/suggestions.ts` already
   * does for #496).
   */
  private _assertSimplePrimaryKey(methodName: string): void {
    // Matches both `PRIMARY KEY (a, b)` and `CONSTRAINT pk_name PRIMARY KEY
    // (a, b)` — the named form is the canonical Postgres pattern used
    // elsewhere in this repo (e.g. UNIQUE constraints on transaction_pairs).
    const hasComposite = this.constraints.some((c) =>
      /(?:^|\s)PRIMARY\s+KEY\s*\(/i.test(c),
    );
    if (hasComposite) {
      throw new Error(
        `Table.${methodName}() is not supported on '${this.name}' — composite PRIMARY KEY tables must use raw pool.query writes in their repository layer.`,
      );
    }
  }

  async query(
    filters: Record<string, ParamValue | unknown> = {},
    options: Omit<SearchFilters, "filters"> = {},
  ): Promise<TModel[]> {
    const { sql, values } = buildSelectWithFilters(this.name, "*", {
      filters,
      // `supportsSoftDelete` stays the default; callers can override
      // (e.g. tombstone-delivery routes set `excludeDeleted: false`).
      excludeDeleted: options.excludeDeleted ?? this.supportsSoftDelete,
      user_id: options.user_id,
      primaryKey: options.primaryKey,
      inFilters: options.inFilters,
      dateRange: options.dateRange,
      orderBy: options.orderBy,
      limit: options.limit,
      offset: options.offset,
    });
    const result = await pool.query(sql, values);
    return result.rows.map((row: unknown) => new this.ModelClass(row));
  }

  async queryOne(filters: Record<string, ParamValue | unknown>): Promise<TModel | null> {
    const { sql, values } = buildSelectWithFilters(this.name, "*", {
      filters,
      limit: 1,
      excludeDeleted: this.supportsSoftDelete,
    });
    const result = await pool.query(sql, values);
    return result.rows.length > 0 ? new this.ModelClass(result.rows[0]) : null;
  }

  async insert(data: QueryData, returning?: string[]): Promise<Record<string, unknown> | null> {
    this._assertSimplePrimaryKey("insert");
    const { sql, values } = buildInsert(
      this.name,
      data as Record<string, ParamValue>,
      returning ?? [this.primaryKey],
    );
    const result = await pool.query(sql, values);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Update one row by primary key.
   *
   * `extraWhere` ANDs additional equality/null guards onto the WHERE — used
   * for compare-and-swap writes (e.g. auto-suggest's "only overwrite rows
   * whose label_category_confidence is still NULL"). Values follow
   * `prepareQuery` semantics: `null` → IS NULL, `IS_NOT_NULL` → IS NOT NULL,
   * anything else → `column = $N`.
   */
  async update(
    primaryKeyValue: ParamValue,
    data: QueryData,
    returning?: string[],
    userId?: string,
    client?: QueryExecutor,
    extraWhere?: AdditionalWhere[],
  ): Promise<Record<string, unknown> | null> {
    this._assertSimplePrimaryKey("update");
    const additionalWhere: AdditionalWhere[] = [];
    if (userId !== undefined) additionalWhere.push({ column: "user_id", value: userId });
    if (extraWhere) additionalWhere.push(...extraWhere);
    const query = buildUpdate(this.name, this.primaryKey, primaryKeyValue, data, {
      returning: returning ?? [this.primaryKey],
      additionalWhere: additionalWhere.length > 0 ? additionalWhere : undefined,
    });
    if (!query) return null;
    const executor = client ?? pool;
    const result = await executor.query(query.sql, query.values);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async upsert(
    data: QueryData,
    updateColumns?: string[],
    client?: QueryExecutor,
  ): Promise<Record<string, unknown> | null> {
    this._assertSimplePrimaryKey("upsert");
    const { sql, values } = buildUpsert(this.name, this.primaryKey, data, {
      updateColumns: updateColumns ?? Object.keys(data).filter((k) => k !== this.primaryKey),
      returning: ["*"],
    });
    const executor = client ?? pool;
    const result = await executor.query(sql, values);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async softDelete(primaryKeyValue: ParamValue, userId?: ParamValue): Promise<boolean> {
    this._assertSimplePrimaryKey("softDelete");
    const { sql, values } = buildSoftDelete(
      this.name,
      this.primaryKey,
      primaryKeyValue,
      userId !== undefined ? { column: "user_id", value: userId } : undefined,
    );
    const result = await pool.query(sql, values);
    return result.rowCount !== null && result.rowCount > 0;
  }

  async queryByIds(
    ids: ParamValue[],
    additionalFilters: Record<string, ParamValue | unknown> = {},
  ): Promise<TModel[]> {
    this._assertSimplePrimaryKey("queryByIds");
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    let sql = `SELECT * FROM ${this.name} WHERE ${this.primaryKey} IN (${placeholders})`;
    if (this.supportsSoftDelete) {
      sql += ` AND (is_deleted IS NULL OR is_deleted = FALSE)`;
    }
    const values: ParamValue[] = [...ids];

    let paramIdx = ids.length + 1;
    for (const [key, value] of Object.entries(additionalFilters)) {
      if (value !== undefined) {
        sql += ` AND ${key} = $${paramIdx++}`;
        values.push(value as ParamValue);
      }
    }

    const result = await pool.query(sql, values);
    return result.rows.map((row: unknown) => new this.ModelClass(row));
  }

  async bulkSoftDelete(
    ids: ParamValue[],
    additionalFilters: Record<string, ParamValue | unknown> = {},
    client?: QueryExecutor,
  ): Promise<number> {
    this._assertSimplePrimaryKey("bulkSoftDelete");
    if (ids.length === 0) return 0;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    let sql = `UPDATE ${this.name} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${this.primaryKey} IN (${placeholders})`;
    const values: ParamValue[] = [...ids];

    let paramIdx = ids.length + 1;
    for (const [key, value] of Object.entries(additionalFilters)) {
      if (value !== undefined) {
        sql += ` AND ${key} = $${paramIdx++}`;
        values.push(value as ParamValue);
      }
    }
    sql += ` RETURNING ${this.primaryKey}`;

    const executor = client ?? pool;
    const result = await executor.query(sql, values);
    return result.rowCount ?? 0;
  }

  async bulkSoftDeleteByColumn(
    column: string,
    columnValue: ParamValue | ParamValue[],
    userIdValue?: ParamValue,
    client?: QueryExecutor,
  ): Promise<number> {
    this._assertSimplePrimaryKey("bulkSoftDeleteByColumn");
    // `columnValue` is either a single value (`column = $1`) or an
    // array (`column = ANY($1)`) — callers with multiple matching ids
    // get one round-trip instead of N.
    const isArray = Array.isArray(columnValue);
    if (isArray && columnValue.length === 0) return 0;
    const predicate = isArray ? `${column} = ANY($1)` : `${column} = $1`;
    let sql = `UPDATE ${this.name} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${predicate}`;
    const values: ParamValue[] = [columnValue as ParamValue];

    if (userIdValue !== undefined) {
      sql += ` AND user_id = $2`;
      values.push(userIdValue);
    }
    sql += ` RETURNING ${this.primaryKey}`;

    const executor = client ?? pool;
    const result = await executor.query(sql, values);
    return result.rowCount ?? 0;
  }

  async hardDelete(primaryKeyValue: ParamValue): Promise<boolean> {
    this._assertSimplePrimaryKey("hardDelete");
    const sql = `DELETE FROM ${this.name} WHERE ${this.primaryKey} = $1 RETURNING ${this.primaryKey}`;
    const result = await pool.query(sql, [primaryKeyValue]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  async bulkHardDelete(ids: ParamValue[]): Promise<number> {
    this._assertSimplePrimaryKey("bulkHardDelete");
    if (ids.length === 0) return 0;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `DELETE FROM ${this.name} WHERE ${this.primaryKey} IN (${placeholders}) RETURNING ${this.primaryKey}`;
    const result = await pool.query(sql, ids);
    return result.rowCount ?? 0;
  }

  async hardDeleteByColumn(column: string, columnValue: ParamValue): Promise<number> {
    this._assertSimplePrimaryKey("hardDeleteByColumn");
    const sql = `DELETE FROM ${this.name} WHERE ${column} = $1 RETURNING ${this.primaryKey}`;
    const result = await pool.query(sql, [columnValue]);
    return result.rowCount ?? 0;
  }

  /**
   * Delete rows matching a condition with comparison operator.
   * @param column Column name to filter on
   * @param operator Comparison operator (=, <=, >=, <, >, !=)
   * @param value Value to compare against
   * @returns Number of rows deleted
   */
  async deleteByCondition(
    column: keyof TSchema & string,
    operator: "=" | "<=" | ">=" | "<" | ">" | "!=",
    value: ParamValue,
  ): Promise<number> {
    this._assertSimplePrimaryKey("deleteByCondition");
    const sql = `DELETE FROM ${this.name} WHERE ${column} ${operator} $1 RETURNING ${this.primaryKey}`;
    const result = await pool.query(sql, [value]);
    return result.rowCount ?? 0;
  }
}

export interface TableConfig<TJSON, TSchema extends Schema, TModel extends Model<TJSON, TSchema>> {
  name: string;
  primaryKey: string;
  schema: TSchema;
  constraints?: Constraints;
  indexes?: IndexDefinition[];
  ModelClass: ModelClass<TJSON, TModel>;
  supportsSoftDelete?: boolean;
}

export function createTable<TJSON, TSchema extends Schema, TModel extends Model<TJSON, TSchema>>(
  config: TableConfig<TJSON, TSchema, TModel>,
): Table<TJSON, TSchema, TModel> {
  return new (class extends Table<TJSON, TSchema, TModel> {
    readonly name = config.name;
    readonly primaryKey = config.primaryKey;
    readonly schema = config.schema;
    readonly constraints = config.constraints ?? [];
    readonly indexes = config.indexes ?? [];
    readonly ModelClass = config.ModelClass;
    readonly supportsSoftDelete = config.supportsSoftDelete ?? true;
  })();
}
