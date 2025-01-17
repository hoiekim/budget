import { Interval } from "common";

export const TWO_WEEKS = 1000 * 60 * 60 * 24 * 14;
export const THIRTY_DAYS = 1000 * 60 * 60 * 24 * 30;

/**
 * This class is designed to determine certain logics with given date.
 * For example: `new IsDate().within("month").from(new Date("2022-08-14"))`
 */
export class IsDate {
  private interval?: Interval;
  private now: Date;

  constructor(date?: Date) {
    const now = date || new Date();
    this.now = now;

    let dayNumber = now.getDay() - 1;
    if (dayNumber === -1) dayNumber = 6;
  }

  public within = (interval: Interval) => {
    this.interval = interval;
    return { from: this.from };
  };

  private from = (date: Date) => {
    const { now, interval } = this;

    const thisYear = now.getFullYear();
    const compareYear = date.getFullYear();
    if (thisYear !== compareYear) return false;
    if (interval === "year") return true;

    const thisMonth = now.getMonth();
    const compareMonth = date.getMonth();
    if (thisMonth !== compareMonth) return false;
    if (interval === "month") return true;

    return false;
  };
}

export class ViewDate {
  protected date: Date;
  protected interval: Interval;

  constructor(interval: Interval, date?: Date) {
    this.interval = interval;
    this.date = date ? new Date(date) : new Date();
    this.current();
  }

  getEndDate = () => this.date;

  getStartDate = () => {
    const clone = this.clone().previous();
    const date = new Date(clone.getEndDate());
    date.setMilliseconds(date.getMilliseconds() + 1);
    return date;
  };

  setInterval = (interval: Interval) => {
    this.interval = interval;
    this.current();
    return this;
  };

  getInterval = () => this.interval;

  getComponents = () => {
    return getDateComponents(this.date);
  };

  current = () => {
    const { interval } = this;
    const { year, month, date } = this.getComponents();
    const newDate = new Date(year, month, date);

    switch (interval) {
      case "year":
        newDate.setDate(1);
        newDate.setMonth(0);
        newDate.setFullYear(year + 1);
        break;
      case "month":
        newDate.setDate(1);
        newDate.setMonth(month + 1);
        break;
    }
    newDate.setMilliseconds(-1);

    this.date = newDate;

    return this;
  };

  next = (n = 1) => {
    const N = Math.round(n) + 1;
    const { interval } = this;
    const { year, month, date } = this.getComponents();
    const newDate = new Date(year, month, date);

    switch (interval) {
      case "year":
        newDate.setDate(1);
        newDate.setMonth(0);
        newDate.setFullYear(year + N);
        break;
      case "month":
        newDate.setDate(1);
        newDate.setMonth(month + N);
        break;
    }
    newDate.setMilliseconds(-1);

    this.date = newDate;

    return this;
  };

  previous = (n = 1) => {
    const N = Math.round(n) - 1;
    const { interval } = this;
    const { year, month, date } = this.getComponents();
    const newDate = new Date(year, month, date);

    switch (interval) {
      case "year":
        newDate.setDate(1);
        newDate.setMonth(0);
        newDate.setFullYear(year - N);
        break;
      case "month":
        newDate.setDate(1);
        newDate.setMonth(month - N);
        break;
    }
    newDate.setMilliseconds(-1);

    this.date = newDate;

    return this;
  };

  clone = () => new ViewDate(this.interval, this.date);

  toString = (options?: Intl.DateTimeFormatOptions & { week?: "long" | "short" }) => {
    const { date, interval } = this;
    let defaultOptions = {};
    let finalOptions = {};
    switch (interval) {
      case "year":
        defaultOptions = { year: "numeric" };
        finalOptions = options || defaultOptions;
        return date.toLocaleString("en-US", finalOptions);
      case "month":
        defaultOptions = { year: "numeric" };
        finalOptions = options || { year: "numeric", month: "short" };
        return date.toLocaleString("en-US", finalOptions);
      default:
        return "";
    }
  };

  has = (date: Date) => {
    const isDate = new IsDate(this.date);
    return isDate.within(this.interval).from(date);
  };

  getSpanFrom = (date: Date) => {
    const { date: thisDate, interval } = this;

    switch (interval) {
      case "year":
        return thisDate.getFullYear() - date.getFullYear();
      case "month":
      default:
        const yearDistance = thisDate.getFullYear() - date.getFullYear();
        return yearDistance * 12 + (thisDate.getMonth() - date.getMonth());
    }
  };
}

const getDateComponents = (dateObject: Date) => {
  const year = dateObject.getFullYear();
  const month = dateObject.getMonth();
  const date = dateObject.getDate();
  const day = dateObject.getDay();
  return { year, month, date, day };
};

const to2DString = (n: Number) => {
  return n.toLocaleString(undefined, { minimumIntegerDigits: 2 });
};

/**
 * @param dateObject Date
 * @returns YYYY-MM-DD
 */
export const getDateString = (dateObject = new Date()) => {
  const { year, month, date } = getDateComponents(dateObject);
  const formattedMonth = to2DString(month + 1);
  const formattedDate = to2DString(date);
  return `${year}-${formattedMonth}-${formattedDate}`;
};

/**
 * @param dateOrString If string, YYYY-MM-DD
 * @returns YYYY-MM-DDT00:00:00
 */
export const getDateTimeString = (dateOrString: Date | string = getDateString()) => {
  const isDate = dateOrString instanceof Date;
  const dateString = isDate ? getDateString(dateOrString) : dateOrString;
  if (dateString.includes("T")) return dateString;
  return dateString + "T00:00:00";
};

export const getLocaleDateString = (date: Date) => {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};
