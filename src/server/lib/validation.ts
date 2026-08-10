/**
 * Lightweight request parameter validation helpers.
 * Uses type checking utilities from the common module.
 */

import type { ServerRequest } from "./route";
import {
  isString,
  isNumber,
  isBoolean,
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
 * Field types a request body can be checked against, named after the column
 * type the value ends up in rather than the JS typeof.
 */
export type FieldType = "string" | "number" | "boolean" | "uuid";

export interface FieldSpec {
  /** Dot path into the body — `"balances.current"`, `"label.budget_id"`. */
  path: string;
  type: FieldType;
  /** Absent (or `undefined`) is an error. Default false: these bodies are partial updates. */
  required?: boolean;
  /** Explicit `null` is accepted — use where the column is nullable. Default false. */
  nullable?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const matchesType = (value: unknown, type: FieldType): boolean => {
  switch (type) {
    case "string":
      return isString(value);
    case "number":
      // Postgres numerics reject NaN/Infinity, and JSON.parse can produce
      // neither — but a hand-built body over the wire can, so pin finiteness
      // here rather than letting the driver decide.
      return isNumber(value) && Number.isFinite(value);
    case "boolean":
      return isBoolean(value);
    case "uuid":
      return isString(value) && UUID_RE.test(value);
  }
};

/**
 * Check a request body's typed fields BEFORE any of them reach SQL.
 *
 * Without this, a body like `{ balances: { current: "abc" } }` or a non-UUID
 * `label.budget_id` travels unchecked into a numeric / `UUID` column, Postgres
 * raises `22P02 invalid_text_representation` at the write, the route throws,
 * and `Route.execute` answers 500 **and** calls `sendAlarm`. A client type
 * error must not page — and while `alarm.ts` still uses one global cooldown,
 * one malformed request a minute suppresses every other server alarm.
 *
 * Returns the FIRST failure so the caller can answer `status: "failed"` with a
 * message that names the offending path. Missing optional fields are skipped:
 * these routes take partial updates, so "absent" and "explicitly wrong" are
 * different answers.
 */
export function validateFields(obj: object, specs: FieldSpec[]): ValidationResult<void> {
  for (const spec of specs) {
    const segments = spec.path.split(".");
    const leaf = segments.pop()!;

    let container: unknown = obj;
    for (const segment of segments) {
      if (isUndefined(container) || isNull(container)) break;
      if (!isObject(container) || isArray(container)) {
        return { success: false, error: `Field ${segment} must be an object` };
      }
      container = (container as Record<string, unknown>)[segment];
    }

    // A parent that isn't there at all leaves nothing to check — the write
    // side skips the whole branch too (`if (a.balances) { … }`).
    if (isUndefined(container) || isNull(container)) {
      if (spec.required) {
        return { success: false, error: `Missing required field: ${spec.path}` };
      }
      continue;
    }
    if (!isObject(container) || isArray(container)) {
      return {
        success: false,
        error: `Field ${segments[segments.length - 1] ?? spec.path} must be an object`,
      };
    }

    const value = (container as Record<string, unknown>)[leaf];

    if (isUndefined(value)) {
      if (spec.required) {
        return { success: false, error: `Missing required field: ${spec.path}` };
      }
      continue;
    }
    if (isNull(value)) {
      if (spec.nullable) continue;
      return { success: false, error: `Field ${spec.path} must be a ${spec.type}` };
    }
    if (!matchesType(value, spec.type)) {
      return { success: false, error: `Field ${spec.path} must be a ${spec.type}` };
    }
  }

  return { success: true };
}

/**
 * Helper to create a failed API response from validation error.
 */
export function validationError(message: string) {
  return { status: "failed" as const, message };
}
