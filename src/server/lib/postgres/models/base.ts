import { QueryResultRow } from "pg";
import { pool } from "../client";
import { buildSelectWithFilters, SearchFilters, ParamValue } from "../database";

export {
  isDefined,
  isPotentialDate,
  isStringArray,
  isNullableString,
  isNullableNumber,
  isNullableBoolean,
  isNullableDate,
  isNullableObject,
  isOptionalString,
  isOptionalNumber,
  isOptionalBoolean,
} from "common";

export { toNumber, toNullableNumber, toDate, toISODateString, toISOString } from "../util";

export class ModelValidationError extends Error {
  public readonly errors: string[];

  constructor(modelName: string, errors: string[]) {
    super(`${modelName} validation failed:\n${errors.join("\n")}`);
    this.name = "ModelValidationError";
    this.errors = errors;
  }
}

export type ColumnDefinition = string;

export type Schema<T> = { [K in keyof T]: ColumnDefinition };

export type Constraints = string[];

export interface IndexDefinition {
  column: string;
}

// Legacy Table interface for backward compatibility
export interface TableDefinition {
  name: string;
  schema: Schema<Record<string, unknown>>;
  constraints: Constraints;
  indexes: IndexDefinition[];
}

export type PropertyChecker<T> = {
  [K in keyof T]: (value: unknown) => boolean;
};

export function validateObject<T extends object>(
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
    const value = obj[key];
    if (!(check as (v: unknown) => boolean)(value)) {
      errors.push(`${key}: ${JSON.stringify(value)} (${typeof value})`);
    }
  }

  return errors;
}

export type AssertTypeFn<T> = (input: unknown, skip?: (keyof T)[]) => asserts input is T;

export function createAssertType<T extends object>(
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

export abstract class Model<TRow, TJSON> {
  abstract toJSON(): TJSON;
  static assertType: AssertTypeFn<any>;
}

export interface TableSearchFilters<T> extends Omit<SearchFilters, 'filters'> {
  filters?: Partial<Record<keyof T, ParamValue>>;
}

export abstract class Table<TRow extends QueryResultRow, TModel extends Model<TRow, any>> {
  abstract readonly name: string;
  abstract readonly schema: Schema<TRow>;
  abstract readonly constraints: Constraints;
  abstract readonly indexes: IndexDefinition[];
  abstract readonly ModelClass: new (row: TRow) => TModel;

  async selectWithFilters(
    columns: (keyof TRow)[] | "*",
    options: TableSearchFilters<TRow> = {}
  ): Promise<TRow[]> {
    const colList = columns === "*" ? "*" : columns as string[];
    const { sql, values } = buildSelectWithFilters(this.name, colList, {
      ...options,
      filters: options.filters as Record<string, ParamValue>,
    });
    const result = await pool.query<TRow>(sql, values);
    return result.rows;
  }

  async findAll(options: TableSearchFilters<TRow> = {}): Promise<TModel[]> {
    const rows = await this.selectWithFilters("*", options);
    return rows.map(row => new this.ModelClass(row));
  }

  async findOne(options: TableSearchFilters<TRow>): Promise<TModel | null> {
    const rows = await this.selectWithFilters("*", { ...options, limit: 1 });
    return rows.length > 0 ? new this.ModelClass(rows[0]) : null;
  }
}
