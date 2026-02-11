/**
 * Base model helpers for validation and type checking.
 * For basic type checkers (isNull, isString, etc.), import from "common" directly.
 */

import {
  isNull,
  isUndefined,
  isString,
  isNumber,
  isBoolean,
  isDate,
  isArray,
  isObject,
} from "common";

export class ModelValidationError extends Error {
  public readonly errors: string[];

  constructor(modelName: string, errors: string[]) {
    super(`${modelName} validation failed:\n${errors.join("\n")}`);
    this.name = "ModelValidationError";
    this.errors = errors;
  }
}

export const isDefined = <T>(v: T | undefined): v is T => v !== undefined;

export const isPotentialDate = (v: unknown): boolean =>
  isDate(v) || (isString(v) && !isNaN(Date.parse(v)));

export const isStringArray = (v: unknown): v is string[] =>
  isArray(v) && v.every(isString);

export const isNullableString = (v: unknown): v is string | null | undefined =>
  isUndefined(v) || isNull(v) || isString(v);

export const isNullableNumber = (v: unknown): v is number | null | undefined =>
  isUndefined(v) || isNull(v) || isNumber(v);

export const isNullableBoolean = (v: unknown): v is boolean | null | undefined =>
  isUndefined(v) || isNull(v) || isBoolean(v);

export const isNullableDate = (v: unknown): v is Date | null | undefined =>
  isUndefined(v) || isNull(v) || isPotentialDate(v);

export const isNullableObject = (v: unknown): v is Record<string, unknown> | null | undefined =>
  isUndefined(v) || isNull(v) || isObject(v);

export const isOptionalString = (v: unknown): v is string | undefined =>
  isUndefined(v) || isString(v);

export const isOptionalNumber = (v: unknown): v is number | undefined =>
  isUndefined(v) || isNumber(v);

export const isOptionalBoolean = (v: unknown): v is boolean | undefined =>
  isUndefined(v) || isBoolean(v);

export type ColumnDefinition = string;

export type Schema<T> = { [K in keyof T]: ColumnDefinition };

export type Constraints = string[];

export interface IndexDefinition {
  table: string;
  column: string;
}

export interface Table {
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
  static assertType: AssertTypeFn<unknown>;
}

export function toNumber(v: unknown, defaultValue: number = 0): number {
  if (isNumber(v)) return v;
  if (isString(v)) {
    const parsed = parseFloat(v);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

export function toNullableNumber(v: unknown): number | null {
  if (isNull(v) || isUndefined(v)) return null;
  if (isNumber(v)) return v;
  if (isString(v)) {
    const parsed = parseFloat(v);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function toDate(v: unknown): Date {
  if (isDate(v)) return v;
  if (isString(v)) return new Date(v);
  return new Date();
}

export function toISODateString(v: unknown): string {
  return toDate(v).toISOString().split("T")[0];
}

export function toISOString(v: unknown): string {
  return toDate(v).toISOString();
}
