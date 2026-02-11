import { isNumber, isString, isDate, isNull, isUndefined, isArray } from "common";

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

export function parseJSONB<T>(value: unknown, defaultValue: T): T {
  if (!value) return defaultValue;
  if (isString(value)) {
    try { return JSON.parse(value); } catch { return defaultValue; }
  }
  return value as T;
}

export const isNullableJSONB = (v: unknown): boolean =>
  isUndefined(v) || isNull(v) || isString(v) || isArray(v);

export function copyDefined<T extends Record<string, unknown>>(
  source: Partial<T>,
  keys: (keyof T)[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key as string] = source[key];
  }
  return result;
}
