export const isNumber = (value: any): value is number => {
  return typeof value === "number" && !isNaN(value);
};

export const isDate = (value: any): value is Date => {
  return value instanceof Date && !isNaN(value.getTime());
};

export const isString = (value: any): value is string => {
  return typeof value === "string";
};

export const isBoolean = (value: any): value is boolean => {
  return typeof value === "boolean";
};

export const isObject = (value: any): value is Record<string, any> => {
  return typeof value === "object" && value !== null;
};

export const isArray = <T>(value: T[] | any): value is T[] => {
  return Array.isArray(value);
};

export const isUndefined = (value: any): value is undefined => {
  return typeof value === "undefined";
};

export const isNull = (value: any): value is null => {
  return value === null;
};

export const isDefined = <T>(v: T | undefined): v is T => v !== undefined;

export const isPotentialDate = (v: unknown): boolean =>
  isDate(v) || (isString(v) && !isNaN(Date.parse(v)));

export const isStringArray = (v: unknown): v is string[] =>
  isArray(v) && v.every(isString);

export const isNullableString = (v: unknown): v is string | null | undefined =>
  isUndefined(v) || isNull(v) || isString(v);

export const isNullableNumber = (v: unknown): v is number | null | undefined =>
  isUndefined(v) || isNull(v) || isNumber(v);

// Accepts number OR numeric string (PostgreSQL DECIMAL returns strings)
export const isNumericLike = (v: unknown): boolean =>
  isNumber(v) || (isString(v) && !isNaN(parseFloat(v)));

export const isNullableNumericLike = (v: unknown): boolean =>
  isUndefined(v) || isNull(v) || isNumericLike(v);

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
