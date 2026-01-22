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
