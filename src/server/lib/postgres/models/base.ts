/**
 * Base model helpers and type checkers.
 * Provides utilities for model validation and type checking.
 */

// =============================================
// Validation Error Class
// =============================================

/**
 * Error thrown when model validation fails.
 * Contains details about which fields failed validation.
 */
export class ModelValidationError extends Error {
  public readonly errors: string[];

  constructor(modelName: string, errors: string[]) {
    super(`${modelName} validation failed:\n${errors.join("\n")}`);
    this.name = "ModelValidationError";
    this.errors = errors;
  }
}

// =============================================
// Type Checkers
// =============================================

export const isNull = (v: unknown): v is null => v === null;

export const isUndefined = (v: unknown): v is undefined => v === undefined;

export const isDefined = <T>(v: T | undefined): v is T => v !== undefined;

export const isString = (v: unknown): v is string => typeof v === "string";

export const isNumber = (v: unknown): v is number =>
  typeof v === "number" && !Number.isNaN(v);

export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export const isDate = (v: unknown): v is Date => v instanceof Date && !isNaN(v.getTime());

export const isPotentialDate = (v: unknown): boolean =>
  isDate(v) || (isString(v) && !isNaN(Date.parse(v)));

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isArray = <T>(v: unknown, itemCheck?: (item: unknown) => item is T): v is T[] =>
  Array.isArray(v) && (!itemCheck || v.every(itemCheck));

export const isStringArray = (v: unknown): v is string[] =>
  isArray(v, isString);

// =============================================
// Nullable/Optional Checkers
// =============================================

export const isNullableString = (v: unknown): v is string | null =>
  isNull(v) || isString(v);

export const isNullableNumber = (v: unknown): v is number | null =>
  isNull(v) || isNumber(v);

export const isNullableBoolean = (v: unknown): v is boolean | null =>
  isNull(v) || isBoolean(v);

export const isNullableDate = (v: unknown): v is Date | null =>
  isNull(v) || isPotentialDate(v);

export const isOptionalString = (v: unknown): v is string | undefined =>
  isUndefined(v) || isString(v);

export const isOptionalNumber = (v: unknown): v is number | undefined =>
  isUndefined(v) || isNumber(v);

export const isOptionalBoolean = (v: unknown): v is boolean | undefined =>
  isUndefined(v) || isBoolean(v);

// =============================================
// Composite Checkers
// =============================================

export const isNullableOrUndefinedString = (v: unknown): v is string | null | undefined =>
  isUndefined(v) || isNull(v) || isString(v);

export const isNullableOrUndefinedNumber = (v: unknown): v is number | null | undefined =>
  isUndefined(v) || isNull(v) || isNumber(v);

export const isNullableOrUndefinedBoolean = (v: unknown): v is boolean | null | undefined =>
  isUndefined(v) || isNull(v) || isBoolean(v);

// =============================================
// Schema Types
// =============================================

/**
 * PostgreSQL type definition for a column.
 * Maps a column name to its PostgreSQL type declaration.
 */
export type ColumnDefinition = string;

/**
 * Schema mapping column names to their PostgreSQL type definitions.
 */
export type Schema<T> = { [K in keyof T]: ColumnDefinition };

/**
 * Constraint definitions for a table (e.g., foreign keys).
 */
export type Constraints = string[];

// =============================================
// Assertion Helpers
// =============================================

/**
 * Type definition for a property validator.
 */
export type PropertyChecker<T> = {
  [K in keyof T]: (value: unknown) => boolean;
};

/**
 * Creates an assertType function for a model.
 * Returns an array of error messages (empty if valid).
 */
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

/**
 * Type for the assertType function.
 */
export type AssertTypeFn<T> = (input: unknown, skip?: (keyof T)[]) => asserts input is T;

/**
 * Creates an assertType static method implementation.
 * Throws ModelValidationError if validation fails.
 */
export function createAssertType<T extends object>(
  modelName: string,
  checker: PropertyChecker<T>
): AssertTypeFn<T> {
  const assertType: AssertTypeFn<T> = (input: unknown, skip: (keyof T)[] = []): asserts input is T => {
    const errors = validateObject(input, checker, skip);
    if (errors.length > 0) {
      throw new ModelValidationError(modelName, errors);
    }
  };
  return assertType;
}

// =============================================
// Value Conversion Helpers
// =============================================

/**
 * Safely converts a value to a number, returning a default if conversion fails.
 */
export function toNumber(v: unknown, defaultValue: number = 0): number {
  if (isNumber(v)) return v;
  if (isString(v)) {
    const parsed = parseFloat(v);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

/**
 * Safely converts a value to a nullable number.
 */
export function toNullableNumber(v: unknown): number | null {
  if (isNull(v) || isUndefined(v)) return null;
  if (isNumber(v)) return v;
  if (isString(v)) {
    const parsed = parseFloat(v);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Safely converts a value to a Date.
 */
export function toDate(v: unknown): Date {
  if (isDate(v)) return v;
  if (isString(v)) return new Date(v);
  return new Date();
}

/**
 * Safely converts a value to an ISO date string (YYYY-MM-DD).
 */
export function toISODateString(v: unknown): string {
  const date = toDate(v);
  return date.toISOString().split("T")[0];
}

/**
 * Safely converts a value to an ISO timestamp string.
 */
export function toISOString(v: unknown): string {
  const date = toDate(v);
  return date.toISOString();
}
