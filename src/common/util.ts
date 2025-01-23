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

export const deepEqual = (x: any, y: any) => {
  return isSubset(x, y, (x, y) => Object.keys(x).length === Object.keys(y).length);
};

export const isSubset = (
  whole: any,
  part: any,
  extraCondition?: (whole: any, part: any) => boolean
) => {
  if (extraCondition && !extraCondition(whole, part)) return false;
  if (whole === part) return true;
  else if (whole && typeof whole === "object" && part && typeof part === "object") {
    for (const prop in part) {
      if (whole.hasOwnProperty(prop)) {
        if (!isSubset(whole[prop], part[prop])) return false;
      } else return false;
    }
    return true;
  } else return false;
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
  return s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
};
