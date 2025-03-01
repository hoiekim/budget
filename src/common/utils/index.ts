const isNodejs = typeof window === "undefined";
const isBrowser = typeof process === "undefined";

export const environment = isNodejs
  ? !isBrowser
    ? "server"
    : "unknown"
  : isBrowser
  ? "client"
  : "unknown";

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

export const getRandomId = () => (65536 + Math.floor(Math.random() * 983040)).toString(16);

export const isEmoji = (s: string) => /\p{Extended_Pictographic}/u.test(s);

export const MAX_FLOAT = 3.402823567e38;

export type Timeout = ReturnType<typeof setTimeout>;

export const clamp = (n: number, min: number, max: number) => {
  return Math.min(Math.max(n, min), max);
};

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? DeepPartial<U>[]
    : T[P] extends object
    ? DeepPartial<T[P]>
    : T[P];
};

export type ValueOf<T> = T[keyof T];

export const assign = <T>(target: T, source: any) => {
  for (const key in source) {
    const value = source[key];
    if (typeof value === "function") continue;
    target[key as keyof T] = value;
  }
  return target;
};

interface IsEqualOptions {
  usePartialMatch?: boolean;
  ignoreFunctions?: boolean;
}

export const isEqual = (x: any, y: any, options?: IsEqualOptions) => {
  const { usePartialMatch = false, ignoreFunctions = true } = options || {};
  if (x === y) {
    return true;
  } else if (ignoreFunctions && typeof x === "function" && typeof y === "function") {
    return true;
  } else if (x && typeof x === "object" && y && typeof y === "object") {
    if (!usePartialMatch && Object.keys(x).length !== Object.keys(y).length) {
      return false;
    }
    for (const prop in y) {
      if (!x.hasOwnProperty(prop)) return false;
      else if (!isEqual(x[prop], y[prop], options)) return false;
    }
    return true;
  } else {
    return false;
  }
};

export const isSubset = (whole: any, part: any) => {
  return isEqual(whole, part, { usePartialMatch: true });
};

const schedule = new Map<string, Timeout>();

const scheduleHandler = (callback: () => void, interval = 1000, pid?: string) => {
  const _pid = pid || getRandomId();

  const timeout = setTimeout(() => {
    if (!schedule.has(_pid)) {
      schedule.delete(_pid);
      return;
    }
    callback();
    scheduleHandler(callback, interval, _pid);
  }, interval);

  schedule.set(_pid, timeout);

  return _pid;
};

export const scheduler = (callback: () => void, interval = 1000) => {
  const pid = scheduleHandler(callback, interval);

  const stop = () => {
    clearTimeout(schedule.get(pid));
    schedule.delete(pid);
  };

  return { stop };
};

export const sleep = (milliseconds: number) => {
  return new Promise((res) => setTimeout(res, milliseconds));
};

export const toTitleCase = (s: string) => {
  return s
    .replace(/_/g, " ")
    .replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
};

export const toUpperCamelCase = (s: string) => {
  return toTitleCase(s).replace(/ /g, "");
};

export * from "./search";
