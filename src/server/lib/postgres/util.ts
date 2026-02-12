import { isUndefined } from "common";

export function copyDefined<T extends Record<string, unknown>>(
  source: Partial<T>,
  keys: (keyof T)[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (!isUndefined(source[key])) result[key as string] = source[key];
  }
  return result;
}
