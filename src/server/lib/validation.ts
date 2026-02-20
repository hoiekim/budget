/**
 * Lightweight request parameter validation helpers.
 * No external dependencies - uses manual type checking.
 */

import { Request } from "express";

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Extract and validate a required string parameter from request query.
 * Handles the case where Express might parse repeated params as arrays.
 */
export function requireQueryString(
  req: Request,
  param: string
): ValidationResult<string> {
  const value = req.query[param];

  if (value === undefined || value === null) {
    return { success: false, error: `Missing required parameter: ${param}` };
  }

  // Express can parse ?id=a&id=b as an array
  if (Array.isArray(value)) {
    return {
      success: false,
      error: `Parameter ${param} must be a single value, not an array`,
    };
  }

  if (typeof value !== "string") {
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
  req: Request,
  param: string
): ValidationResult<string | undefined> {
  const value = req.query[param];

  if (value === undefined || value === null) {
    return { success: true, data: undefined };
  }

  // Express can parse ?id=a&id=b as an array
  if (Array.isArray(value)) {
    return {
      success: false,
      error: `Parameter ${param} must be a single value, not an array`,
    };
  }

  if (typeof value !== "string") {
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
export function requireBodyObject(req: Request): ValidationResult<object> {
  const body = req.body;

  if (body === undefined || body === null) {
    return { success: false, error: "Request body is required" };
  }

  if (typeof body !== "object" || Array.isArray(body)) {
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

  if (value === undefined || value === null) {
    return { success: false, error: `Missing required field: ${String(field)}` };
  }

  if (typeof value !== "string") {
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

  if (value === undefined || value === null) {
    return { success: false, error: `Missing required field: ${String(field)}` };
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      success: false,
      error: `Field ${String(field)} must be a number`,
    };
  }

  return { success: true, data: value };
}

/**
 * Helper to create a failed API response from validation error.
 */
export function validationError(message: string) {
  return { status: "failed" as const, message };
}
