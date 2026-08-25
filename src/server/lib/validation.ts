/**
 * Lightweight request parameter validation helpers.
 * Uses type checking utilities from the common module.
 */

import type { ServerRequest } from "./route";
import {
  isString,
  isNumber,
  isArray,
  isObject,
  isUndefined,
  isNull,
  LocalDate,
} from "common";

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Extract and validate a required string parameter from request query.
 * Handles the case where query parsing might produce arrays for repeated params.
 */
export function requireQueryString(
  req: ServerRequest,
  param: string
): ValidationResult<string> {
  const value = req.query[param];

  if (isUndefined(value) || isNull(value)) {
    return { success: false, error: `Missing required parameter: ${param}` };
  }

  // Repeated params (e.g. ?id=a&id=b) are parsed as arrays
  if (isArray(value)) {
    return {
      success: false,
      error: `Parameter ${param} must be a single value, not an array`,
    };
  }

  if (!isString(value)) {
    return {
      success: false,
      error: `Parameter ${param} must be a string`,
    };
  }

  if (value.trim() === "") {
    return { success: false, error: `Parameter ${param} cannot be empty` };
  }

  return { success: true, data: value };
}

/**
 * Extract an optional string parameter from request query.
 * Returns undefined if not present.
 */
export function optionalQueryString(
  req: ServerRequest,
  param: string
): ValidationResult<string | undefined> {
  const value = req.query[param];

  if (isUndefined(value) || isNull(value)) {
    return { success: true, data: undefined };
  }

  // Repeated params are parsed as arrays
  if (isArray(value)) {
    return {
      success: false,
      error: `Parameter ${param} must be a single value, not an array`,
    };
  }

  if (!isString(value)) {
    return {
      success: false,
      error: `Parameter ${param} must be a string`,
    };
  }

  return { success: true, data: value || undefined };
}

/**
 * Validate that request body is a non-null object.
 */
export function requireBodyObject(req: ServerRequest): ValidationResult<object> {
  const body = req.body;

  if (isUndefined(body) || isNull(body)) {
    return { success: false, error: "Request body is required" };
  }

  if (!isObject(body) || isArray(body)) {
    return { success: false, error: "Request body must be an object" };
  }

  return { success: true, data: body };
}

/**
 * Validate that a required string field exists in an object.
 */
export function requireStringField<T extends object>(
  obj: T,
  field: keyof T
): ValidationResult<string> {
  const value = obj[field];

  if (isUndefined(value) || isNull(value)) {
    return { success: false, error: `Missing required field: ${String(field)}` };
  }

  if (!isString(value)) {
    return {
      success: false,
      error: `Field ${String(field)} must be a string`,
    };
  }

  return { success: true, data: value };
}

/**
 * Validate that a required number field exists in an object.
 */
export function requireNumberField<T extends object>(
  obj: T,
  field: keyof T
): ValidationResult<number> {
  const value = obj[field];

  if (isUndefined(value) || isNull(value)) {
    return { success: false, error: `Missing required field: ${String(field)}` };
  }

  if (!isNumber(value) || !Number.isFinite(value)) {
    return {
      success: false,
      error: `Field ${String(field)} must be a number`,
    };
  }

  return { success: true, data: value };
}

/**
 * Parse an optional caller-supplied date field into a `LocalDate`.
 *
 * An absent, null or empty value yields `undefined` so the caller keeps its own
 * default. Anything else is rejected here rather than becoming an `Invalid
 * Date` that survives until `getSquashedDateString` mints a `NaNNaNNaN` id or
 * `toISOString` throws a `RangeError` past the handler's try block.
 *
 * ```ts
 * const parsed = optionalDateField(body, "snapshot_date");
 * if (!parsed.success) return validationError(parsed.error!);
 * const date = parsed.data ?? new Date();
 * ```
 */
export function optionalDateField<T extends object>(
  obj: T,
  field: keyof T,
  label: string = String(field)
): ValidationResult<Date | undefined> {
  const value = obj[field];

  if (isUndefined(value) || isNull(value) || value === "") {
    return { success: true, data: undefined };
  }

  if (!isString(value)) {
    return { success: false, error: `${label} must be a string` };
  }

  const date = new LocalDate(value);

  if (Number.isNaN(date.getTime())) {
    return { success: false, error: `${label} is not a valid date` };
  }

  return { success: true, data: date };
}

/**
 * Helper to create a failed API response from validation error.
 */
export function validationError(message: string) {
  return { status: "failed" as const, message };
}
