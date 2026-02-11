/**
 * Conversion utilities for database values.
 * Use these after assertType validation.
 */

import { isNumber, isString, isDate, isNull, isUndefined } from "common";

export function toNumber(v: string | number | null | undefined, defaultValue: number = 0): number {
  if (isNumber(v)) return v;
  if (isString(v)) {
    const parsed = parseFloat(v);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

export function toNullableNumber(v: string | number | null | undefined): number | null {
  if (isNull(v) || isUndefined(v)) return null;
  if (isNumber(v)) return v;
  if (isString(v)) {
    const parsed = parseFloat(v);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function toDate(v: string | Date | null | undefined): Date {
  if (isDate(v)) return v;
  if (isString(v)) return new Date(v);
  return new Date();
}

export function toISODateString(v: string | Date | null | undefined): string {
  return toDate(v).toISOString().split("T")[0];
}

export function toISOString(v: string | Date | null | undefined): string {
  return toDate(v).toISOString();
}
