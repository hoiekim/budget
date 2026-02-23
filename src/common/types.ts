export const isNumber = (value: unknown): value is number => {
  return typeof value === "number" && !isNaN(value);
};

export const isDate = (value: unknown): value is Date => {
  return value instanceof Date && !isNaN(value.getTime());
};

export const isString = (value: unknown): value is string => {
  return typeof value === "string";
};

export const isBoolean = (value: unknown): value is boolean => {
  return typeof value === "boolean";
};

export const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export const isArray = <T>(value: T[] | unknown): value is T[] => {
  return Array.isArray(value);
};

export const isUndefined = (value: unknown): value is undefined => {
  return typeof value === "undefined";
};

export const isNull = (value: unknown): value is null => {
  return value === null;
};

export const isDefined = <T>(v: T | undefined): v is T => v !== undefined;

export const isPotentialDate = (v: unknown): boolean =>
  isDate(v) || (isString(v) && !isNaN(Date.parse(v)));

export const isStringArray = (v: unknown): v is string[] =>
  isArray(v) && v.every(isString);

export const isNullableString = (v: unknown): v is string | null =>
  isNull(v) || isString(v);

export const isNullableNumber = (v: unknown): v is number | null =>
  isNull(v) || isNumber(v);

export const isNullableBoolean = (v: unknown): v is boolean | null =>
  isNull(v) || isBoolean(v);

export const isNullableDate = (v: unknown): v is Date | null =>
  isNull(v) || isPotentialDate(v);

export const isNullableObject = (v: unknown): v is Record<string, unknown> | null =>
  isNull(v) || isObject(v);

export const isNullableArray = <T>(v: unknown): v is T[] | null =>
  isNull(v) || isArray(v);

export const isOptionalString = (v: unknown): v is string | undefined =>
  isUndefined(v) || isString(v);

export const isOptionalNumber = (v: unknown): v is number | undefined =>
  isUndefined(v) || isNumber(v);

export const isOptionalBoolean = (v: unknown): v is boolean | undefined =>
  isUndefined(v) || isBoolean(v);
