import { Interval } from "server";

/**
 * This class is designed to determine certain logics with given date.
 * For example: `new IsDate().within("week").from(new Date("2022-08-14"))`
 */
export class IsDate {
  private interval?: Interval;
  private now: Date;
  private millisecThisWeek: number;

  constructor(date?: Date) {
    const now = date || new Date();
    this.now = now;

    let dayNumber = now.getDay() - 1;
    if (dayNumber === -1) dayNumber = 6;

    const minutesToday = now.getMinutes() + now.getHours() * 60;
    const secToday = now.getSeconds() + minutesToday * 60;
    const millisecToday = now.getMilliseconds() + secToday * 1000;

    this.millisecThisWeek = dayNumber * 24 * 60 * 60 * 1000 + millisecToday;
  }

  public within = (interval: Interval) => {
    this.interval = interval;
    return { from: this.from };
  };

  private from = (date: Date) => {
    const { now, interval, millisecThisWeek } = this;

    if (interval === "week") {
      const delta = now.getTime() - date.getTime();
      return millisecThisWeek >= delta && delta > 0;
    }

    const thisYear = now.getFullYear();
    const compareYear = date.getFullYear();
    if (thisYear !== compareYear) return false;
    if (interval === "year") return true;

    const thisMonth = now.getMonth();
    const compareMonth = date.getMonth();
    if (thisMonth !== compareMonth) return false;
    if (interval === "month") return true;

    const todayDate = now.getDate();
    const compareDate = date.getDate();
    if (todayDate !== compareDate) return false;
    if (interval === "day") return true;

    return false;
  };
}

const oneDay = 24 * 60 * 60 * 1000;

export class ViewDate {
  protected date: Date;
  protected interval: Interval;

  constructor(interval: Interval, date?: Date) {
    this.interval = interval;
    this.date = date || new Date();
    this.current();
  }

  setInterval = (interval: Interval) => {
    this.interval = interval;
    this.current();
    return this;
  };

  getInterval = () => this.interval;

  getComponents = () => {
    const { date: dateObject } = this;
    const year = dateObject.getFullYear();
    const month = dateObject.getMonth();
    const date = dateObject.getDate();
    const day = dateObject.getDay();
    return { year, month, date, day };
  };

  current = () => {
    const { interval } = this;
    const { year, month, date, day } = this.getComponents();
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
      case "week":
        const lastMonday = date - day + (day === 0 ? -6 : 1);
        const nextMonday = lastMonday + 7;
        newDate.setDate(nextMonday);
        break;
      case "day":
        newDate.setDate(date + 1);
        break;
    }
    newDate.setMilliseconds(-1);

    this.date = newDate;

    return newDate;
  };

  next = () => {
    const { interval } = this;
    const { year, month, date, day } = this.getComponents();
    const newDate = new Date(year, month, date);

    switch (interval) {
      case "year":
        newDate.setDate(1);
        newDate.setMonth(0);
        newDate.setFullYear(year + 2);
        break;
      case "month":
        newDate.setDate(1);
        newDate.setMonth(month + 2);
        break;
      case "week":
        const lastMonday = date - day + (day === 0 ? -6 : 1);
        const nextNextMonday = lastMonday + 7 * 2;
        newDate.setDate(nextNextMonday);
        break;
      case "day":
        newDate.setDate(date + 2);
        break;
    }
    newDate.setMilliseconds(-1);

    this.date = newDate;
    return newDate;
  };

  previous = () => {
    const { interval } = this;
    const { year, month, date, day } = this.getComponents();
    const newDate = new Date(year, month, date);

    switch (interval) {
      case "year":
        newDate.setDate(1);
        newDate.setMonth(0);
        break;
      case "month":
        newDate.setDate(1);
        break;
      case "week":
        const lastMonday = date - day + (day === 0 ? -6 : 1);
        newDate.setDate(lastMonday);
        break;
    }
    newDate.setMilliseconds(-1);

    this.date = newDate;
    return newDate;
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
      case "week":
        const startDate = new Date(date.getFullYear(), 0, 1);
        const days = Math.floor((date.getTime() - startDate.getTime()) / oneDay);
        const weekNumber = Math.ceil(days / 7);
        const isShortWeek = options?.week === "short";
        delete options?.week;
        const weekText = isShortWeek ? `W${weekNumber}` : `Week ${weekNumber}`;
        defaultOptions = { year: "numeric" };
        finalOptions = options || defaultOptions;
        if (!Object.keys(finalOptions).length) return weekText;
        return weekText + ", " + date.toLocaleString("en-US", finalOptions);
      case "day":
        defaultOptions = { year: "numeric", month: "short", day: "2-digit" };
        finalOptions = options || defaultOptions;
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
        const yearDistance = thisDate.getFullYear() - date.getFullYear();
        return yearDistance * 12 + (thisDate.getMonth() - date.getMonth());
      case "week":
        return Math.floor((thisDate.getTime() - date.getTime()) / oneDay / 7);
      case "day":
      default:
        return Math.floor((thisDate.getTime() - date.getTime()) / oneDay);
    }
  };
}
