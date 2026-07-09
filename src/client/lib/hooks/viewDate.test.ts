import { describe, test, expect } from "bun:test";
import { parseViewDateString } from "./viewDate";

describe("parseViewDateString", () => {
  test("YYYY-MM parses to the correct month", () => {
    // Reads position 5-6 for month via `parseYearMonthString`. Pre-fix,
    // the hook used `substring(4, 6)` which grabbed the dash + first
    // month digit ("-0"), parseInt("-0") = 0, || 1 → month index 0,
    // resetting every session to January of the year in URL. This
    // pins the corrected behavior.
    const { interval, date } = parseViewDateString("2026-07");
    expect(interval).toBe("month");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(6); // July (0-indexed)
  });

  test("YYYY-01 parses January without off-by-one", () => {
    const { interval, date } = parseViewDateString("2026-01");
    expect(interval).toBe("month");
    expect(date.getMonth()).toBe(0);
  });

  test("YYYY-12 parses December without off-by-one", () => {
    const { interval, date } = parseViewDateString("2026-12");
    expect(interval).toBe("month");
    expect(date.getMonth()).toBe(11);
  });

  test("YYYY parses to year interval + January 1st of that year", () => {
    // Year interval is still readable so a bookmarked year URL still
    // works even though there's no UI toggle post-Header simplification.
    const { interval, date } = parseViewDateString("2026");
    expect(interval).toBe("year");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(0);
  });

  test("garbage input falls back to month interval + today", () => {
    // Invalid input shouldn't throw. Falls back to `new Date()` for
    // the date; interval defaults to month. Pin so a hand-edited URL
    // can't crash the app.
    const before = Date.now();
    const { interval, date } = parseViewDateString("garbage");
    const after = Date.now();
    expect(interval).toBe("month");
    expect(date.getTime()).toBeGreaterThanOrEqual(before);
    expect(date.getTime()).toBeLessThanOrEqual(after);
  });

  test("empty string falls back to month interval + today", () => {
    const before = Date.now();
    const { interval, date } = parseViewDateString("");
    const after = Date.now();
    expect(interval).toBe("month");
    expect(date.getTime()).toBeGreaterThanOrEqual(before);
    expect(date.getTime()).toBeLessThanOrEqual(after);
  });
});
