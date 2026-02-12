import { pool } from "../client";
import { buildSelectWithFilters, buildInsert, buildUpdate, buildUpsert, buildSoftDelete, SearchFilters, ParamValue, QueryData } from "../database";

export class ModelValidationError extends Error {
  public readonly errors: string[];

  constructor(modelName: string, errors: string[]) {
    super(`${modelName} validation failed:\n${errors.join("\n")}`);
    this.name = "ModelValidationError";
    this.errors = errors;
  }
}

export type ColumnDefinition = string;

export type Schema<T> = { [K in keyof T]?: ColumnDefinition };

export type Constraints = string[];

export interface IndexDefinition {
  column: string;
}

export type PropertyChecker<T> = {
  [K in keyof T]?: (value: unknown) => boolean;
};

export function validateObject<T extends Record<string, unknown>>(
  input: unknown,
  checker: PropertyChecker<T>,
  skip: (keyof T)[] = []
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

export type AssertTypeFn<T> = (input: unknown, skip?: (keyof T)[]) => asserts input is T;

export function createAssertType<T extends Record<string, unknown>>(
  modelName: string,
  checker: PropertyChecker<T>
): AssertTypeFn<T> {
  return (input: unknown, skip: (keyof T)[] = []): asserts input is T => {
    const errors = validateObject(input, checker, skip);
    if (errors.length > 0) {
      throw new ModelValidationError(modelName, errors);
    }
  };
}

export abstract class Model<TJSON> {
  abstract toJSON(): TJSON;
  static assertType: AssertTypeFn<Record<string, unknown>>;
}

export interface ModelClass<TJSON, TModel extends Model<TJSON>> {
  new (data: unknown): TModel;
  assertType: AssertTypeFn<Record<string, unknown>>;
}

export interface TableSearchFilters extends Omit<SearchFilters, 'filters'> {
  filters?: Record<string, ParamValue>;
}

export abstract class Table<TJSON, TModel extends Model<TJSON>> {
  abstract readonly name: string;
  abstract readonly primaryKey: string;
  abstract readonly schema: Schema<Record<string, unknown>>;
  abstract readonly constraints: Constraints;
  abstract readonly indexes: IndexDefinition[];
  abstract readonly ModelClass: ModelClass<TJSON, TModel>;

  async query(filters: Record<string, ParamValue | unknown> = {}): Promise<TModel[]> {
    const { sql, values } = buildSelectWithFilters(this.name, "*", { filters });
    const result = await pool.query(sql, values);
    return result.rows.map((row: unknown) => new this.ModelClass(row));
  }

  async queryOne(filters: Record<string, ParamValue | unknown>): Promise<TModel | null> {
    const { sql, values } = buildSelectWithFilters(this.name, "*", { filters, limit: 1 });
    const result = await pool.query(sql, values);
    return result.rows.length > 0 ? new this.ModelClass(result.rows[0]) : null;
  }

  async insert(data: QueryData, returning?: string[]): Promise<TModel | null> {
    const { sql, values } = buildInsert(this.name, data as Record<string, ParamValue>, returning ?? [this.primaryKey]);
    const result = await pool.query(sql, values);
    return result.rows.length > 0 ? new this.ModelClass(result.rows[0]) : null;
  }

  async update(primaryKeyValue: ParamValue, data: QueryData, returning?: string[]): Promise<TModel | null> {
    const query = buildUpdate(this.name, this.primaryKey, primaryKeyValue, data, { returning: returning ?? [this.primaryKey] });
    if (!query) return null;
    const result = await pool.query(query.sql, query.values);
    return result.rows.length > 0 ? new this.ModelClass(result.rows[0]) : null;
  }

  async upsert(data: QueryData, updateColumns?: string[]): Promise<TModel | null> {
    const { sql, values } = buildUpsert(this.name, this.primaryKey, data, {
      updateColumns: updateColumns ?? Object.keys(data).filter(k => k !== this.primaryKey),
      returning: ["*"],
    });
    const result = await pool.query(sql, values);
    return result.rows.length > 0 ? new this.ModelClass(result.rows[0]) : null;
  }

  async softDelete(primaryKeyValue: ParamValue): Promise<boolean> {
    const { sql, values } = buildSoftDelete(this.name, this.primaryKey, primaryKeyValue);
    const result = await pool.query(sql, values);
    return result.rowCount !== null && result.rowCount > 0;
  }
}

export interface TableConfig<TJSON, TModel extends Model<TJSON>> {
  name: string;
  primaryKey: string;
  schema: Schema<Record<string, unknown>>;
  constraints?: Constraints;
  indexes?: IndexDefinition[];
  ModelClass: ModelClass<TJSON, TModel>;
}

export function createTable<TJSON, TModel extends Model<TJSON>>(
  config: TableConfig<TJSON, TModel>
): Table<TJSON, TModel> {
  return new (class extends Table<TJSON, TModel> {
    readonly name = config.name;
    readonly primaryKey = config.primaryKey;
    readonly schema = config.schema;
    readonly constraints = config.constraints ?? [];
    readonly indexes = config.indexes ?? [];
    readonly ModelClass = config.ModelClass;
  })();
}
