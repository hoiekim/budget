export const numberToCommaString = (n: number, fixed = 2) => {
  const sign = n < 0 ? "-" : "";

  const splitNumberString = Math.abs(n).toFixed(fixed).toString().split(".");
  const firstPart = splitNumberString[0];
  const secondPart = splitNumberString[1];

  const { length } = firstPart;
  let integer = "";
  let i = 0;
  let skip = length % 3;
  while (i < length) {
    if (i && !((i - skip) % 3)) integer += ",";
    integer += firstPart[i];
    i++;
  }

  const fraction = secondPart ? "." + secondPart : "";

  return sign + integer + fraction;
};

export const currencyCodeToSymbol = (code: string) => {
  switch (code) {
    case "USD":
      return "$";
    default:
      return code;
  }
};

export const getRandomId = () =>
  (65536 + Math.floor(Math.random() * 983040)).toString(16);

export const isEmoji = (s: string) => /\p{Extended_Pictographic}/u.test(s);

export const MAX_FLOAT = 3.402823567e38;

export type Timeout = ReturnType<typeof setTimeout>;

export const clamp = (n: number, min: number, max: number) => {
  return Math.min(Math.max(n, min), max);
};

export const getIndex = <T = any>(e: T, arr: T[]): number | undefined => {
  let i: number | undefined = undefined;
  arr.find((f, j) => {
    if (e === f) {
      i = j;
      return true;
    }
    return false;
  });
  return i;
};

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? DeepPartial<U>[]
    : T[P] extends object
    ? DeepPartial<T[P]>
    : T[P];
};

export type ValueOf<T> = T[keyof T];

const isNodejs = typeof window === "undefined";
const isBrowser = typeof process === "undefined";

export const environment = isNodejs
  ? !isBrowser
    ? "server"
    : "unknown"
  : isBrowser
  ? "client"
  : "unknown";

export const assign = (target: any, source: any) => {
  for (const key in source) {
    const value = source[key];
    if (typeof value === "function") continue;
    target[key] = value;
  }
};
