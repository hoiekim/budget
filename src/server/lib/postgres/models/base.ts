import { pool } from "../client";
import { buildSelectWithFilters, SearchFilters, ParamValue } from "../database";

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
  abstract readonly schema: Schema<Record<string, unknown>>;
  abstract readonly constraints: Constraints;
  abstract readonly indexes: IndexDefinition[];
  abstract readonly ModelClass: ModelClass<TJSON, TModel>;

  async query(options: TableSearchFilters = {}): Promise<TModel[]> {
    const { sql, values } = buildSelectWithFilters(this.name, "*", options);
    const result = await pool.query(sql, values);
    return result.rows.map((row: unknown) => new this.ModelClass(row));
  }

  async queryOne(options: TableSearchFilters): Promise<TModel | null> {
    const models = await this.query({ ...options, limit: 1 });
    return models.length > 0 ? models[0] : null;
  }
}
