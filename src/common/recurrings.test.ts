import { describe, expect, it } from "bun:test";
import { getNextRecurringDate } from "./recurrings";
import { getDateString } from "./utils";

const next = (latest: string, cadence: Parameters<typeof getNextRecurringDate>[1], today: string) => {
  const result = getNextRecurringDate(new Date(latest + "T00:00:00"), cadence, new Date(today + "T12:00:00"));
  return result && getDateString(result);
};

describe("getNextRecurringDate", () => {
  it("steps one period past the latest occurrence", () => {
    expect(next("2026-10-02", "monthly", "2026-10-16")).toBe("2026-11-02");
    expect(next("2026-10-14", "weekly", "2026-10-16")).toBe("2026-10-21");
    expect(next("2026-10-09", "biweekly", "2026-10-16")).toBe("2026-10-23");
    expect(next("2026-08-15", "quarterly", "2026-10-16")).toBe("2026-11-15");
    expect(next("2026-05-01", "semiannual", "2026-10-16")).toBe("2026-11-01");
    expect(next("2026-03-10", "annual", "2026-10-16")).toBe("2027-03-10");
  });

  it("counts a step landing today as due today", () => {
    expect(next("2026-09-16", "monthly", "2026-10-16")).toBe("2026-10-16");
  });

  it("rolls past periods that have already gone by", () => {
    expect(next("2026-07-02", "monthly", "2026-10-16")).toBe("2026-11-02");
    expect(next("2026-09-01", "weekly", "2026-10-16")).toBe("2026-10-20");
  });

  it("clamps to the month's last day without drifting off the anchor day", () => {
    expect(next("2026-01-31", "monthly", "2026-02-01")).toBe("2026-02-28");
    expect(next("2026-01-31", "monthly", "2026-03-01")).toBe("2026-03-31");
    expect(next("2024-02-29", "annual", "2024-03-01")).toBe("2025-02-28");
  });

  it("crosses year boundaries", () => {
    expect(next("2026-12-28", "weekly", "2026-12-30")).toBe("2027-01-04");
    expect(next("2026-11-30", "quarterly", "2026-12-01")).toBe("2027-02-28");
  });

  it("returns null for an unparseable date", () => {
    expect(getNextRecurringDate(new Date("nope"), "monthly")).toBeNull();
    expect(getNextRecurringDate(new Date(), "monthly", new Date("nope"))).toBeNull();
  });
});
