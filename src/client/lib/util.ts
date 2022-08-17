import { Interval } from "server";

export const numberToCommaString = (n: number) => {
  const sign = n < 0 ? "-" : "";

  const splitNumberString = Math.abs(n).toFixed(2).toString().split(".");
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

/**
 * This class is designed to determine certain logics with given date.
 * For example: `isNow.within("week").from("2022-08-14")`
 */
export class IsNow {
  private interval?: Interval;
  private now: Date;
  private millisecThisWeek: number;

  constructor() {
    const now = new Date();
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
      return millisecThisWeek >= delta;
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

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? DeepPartial<U>[]
    : T[P] extends object
    ? DeepPartial<T[P]>
    : T[P];
};
