import { describe, expect, it } from "bun:test";
import {
  getDateString,
  getSquashedDateString,
  getDateTimeString,
  getYearMonthString,
  getLocaleDateString,
  LocalDate,
  ViewDate,
  IsDate,
} from "./date";

describe("getDateString", () => {
  it("should format date as YYYY-MM-DD", () => {
    const date = new Date(2024, 5, 15); // June 15, 2024
    expect(getDateString(date)).toBe("2024-06-15");
  });

  it("should pad single-digit months", () => {
    const date = new Date(2024, 0, 1); // January 1, 2024
    expect(getDateString(date)).toBe("2024-01-01");
  });

  it("should pad single-digit days", () => {
    const date = new Date(2024, 11, 5); // December 5, 2024
    expect(getDateString(date)).toBe("2024-12-05");
  });
});

describe("getSquashedDateString", () => {
  it("should format date as YYYYMMDD", () => {
    const date = new Date(2024, 5, 15);
    expect(getSquashedDateString(date)).toBe("20240615");
  });

  it("should pad single-digit months and days", () => {
    const date = new Date(2024, 0, 1);
    expect(getSquashedDateString(date)).toBe("20240101");
  });
});

describe("getDateTimeString", () => {
  it("should add T00:00:00 to date string", () => {
    expect(getDateTimeString("2024-06-15")).toBe("2024-06-15T00:00:00");
  });

  it("should not duplicate T if already present", () => {
    expect(getDateTimeString("2024-06-15T12:30:00")).toBe("2024-06-15T12:30:00");
  });

  it("should handle Date objects", () => {
    const date = new Date(2024, 5, 15);
    expect(getDateTimeString(date)).toBe("2024-06-15T00:00:00");
  });
});

describe("getYearMonthString", () => {
  it("should format date as YYYY-MM", () => {
    const date = new Date(2024, 5, 15);
    expect(getYearMonthString(date)).toBe("2024-06");
  });

  it("should pad single-digit months", () => {
    const date = new Date(2024, 0, 15);
    expect(getYearMonthString(date)).toBe("2024-01");
  });
});

describe("getLocaleDateString", () => {
  it("should format date in US locale", () => {
    const date = new Date(2024, 5, 15);
    const result = getLocaleDateString(date);
    expect(result).toContain("Jun");
    expect(result).toContain("15");
    expect(result).toContain("2024");
  });
});

describe("LocalDate", () => {
  it("should interpret YYYY-MM-DD as local timezone", () => {
    const date = new LocalDate("2024-06-15");
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(5); // June
    expect(date.getDate()).toBe(15);
  });

  it("should handle Date objects", () => {
    const original = new Date(2024, 5, 15);
    const local = new LocalDate(original);
    expect(local.getFullYear()).toBe(2024);
    expect(local.getMonth()).toBe(5);
    expect(local.getDate()).toBe(15);
  });

  it("should handle timestamps", () => {
    const timestamp = new Date(2024, 5, 15).getTime();
    const local = new LocalDate(timestamp);
    expect(local.getFullYear()).toBe(2024);
  });

  it("should default to current date", () => {
    const local = new LocalDate();
    const now = new Date();
    expect(local.getFullYear()).toBe(now.getFullYear());
  });

  // Timezone-specific tests
  describe("timezone handling", () => {
    it("should avoid off-by-one day issues that occur with regular Date parsing", () => {
      // Regular Date("YYYY-MM-DD") interprets as UTC midnight, which can shift
      // the local date backwards in negative UTC offset timezones (e.g., PST/PDT).
      // LocalDate should always give the expected local date.
      const dateString = "2024-01-15";
      const localDate = new LocalDate(dateString);

      // LocalDate should always return the date as written in the string
      expect(localDate.getDate()).toBe(15);
      expect(localDate.getMonth()).toBe(0); // January
      expect(localDate.getFullYear()).toBe(2024);
    });

    it("should preserve date components regardless of timezone offset", () => {
      // Test multiple dates throughout the year to catch DST edge cases
      const testDates = [
        "2024-01-01", // New Year's Day (standard time)
        "2024-03-10", // DST transition day (US)
        "2024-06-15", // Summer (daylight time)
        "2024-11-03", // DST fall-back day (US)
        "2024-12-31", // New Year's Eve
      ];

      for (const dateString of testDates) {
        const localDate = new LocalDate(dateString);
        const [year, month, day] = dateString.split("-").map(Number);

        expect(localDate.getFullYear()).toBe(year);
        expect(localDate.getMonth()).toBe(month - 1); // JS months are 0-indexed
        expect(localDate.getDate()).toBe(day);
      }
    });

    it("should handle ISO date strings with time component normally", () => {
      // When a time component is included, LocalDate should behave like regular Date
      const isoString = "2024-06-15T12:30:00";
      const localDate = new LocalDate(isoString);
      const regularDate = new Date(isoString);

      expect(localDate.getTime()).toBe(regularDate.getTime());
    });

    it("should have different internal time than regular Date for YYYY-MM-DD strings", () => {
      // This test demonstrates the core difference: LocalDate interprets the
      // date string as local midnight, while regular Date interprets it as UTC midnight
      const dateString = "2024-06-15";
      const localDate = new LocalDate(dateString);
      const regularDate = new Date(dateString);

      // They should represent the same calendar date in local time
      expect(localDate.getDate()).toBe(15);

      // But their internal timestamps differ by the timezone offset
      // (unless in UTC+0 timezone)
      const timezoneOffsetMs = localDate.getTimezoneOffset() * 60 * 1000;
      if (timezoneOffsetMs !== 0) {
        expect(localDate.getTime()).not.toBe(regularDate.getTime());
        expect(localDate.getTime() - regularDate.getTime()).toBe(timezoneOffsetMs);
      }
    });
  });
});

describe("ViewDate", () => {
  describe("month interval", () => {
    it("should get end of month", () => {
      const view = new ViewDate("month", new Date(2024, 5, 15)); // June 15
      const end = view.getEndDate();
      expect(end.getMonth()).toBe(5); // June
      expect(end.getDate()).toBe(30); // Last day of June
    });

    it("should get start of month", () => {
      const view = new ViewDate("month", new Date(2024, 5, 15));
      const start = view.getStartDate();
      expect(start.getMonth()).toBe(5);
      expect(start.getDate()).toBe(1);
    });

    it("should navigate to next month", () => {
      const view = new ViewDate("month", new Date(2024, 5, 15));
      view.next();
      const end = view.getEndDate();
      expect(end.getMonth()).toBe(6); // July
    });

    it("should navigate to previous month", () => {
      const view = new ViewDate("month", new Date(2024, 5, 15));
      view.previous();
      const end = view.getEndDate();
      expect(end.getMonth()).toBe(4); // May
    });
  });

  describe("year interval", () => {
    it("should get end of year", () => {
      const view = new ViewDate("year", new Date(2024, 5, 15));
      const end = view.getEndDate();
      expect(end.getFullYear()).toBe(2024);
      expect(end.getMonth()).toBe(11); // December
      expect(end.getDate()).toBe(31);
    });

    it("should get start of year", () => {
      const view = new ViewDate("year", new Date(2024, 5, 15));
      const start = view.getStartDate();
      expect(start.getFullYear()).toBe(2024);
      expect(start.getMonth()).toBe(0); // January
      expect(start.getDate()).toBe(1);
    });
  });

  it("should clone correctly", () => {
    const view = new ViewDate("month", new Date(2024, 5, 15));
    const clone = view.clone();
    clone.next();
    // Original should be unchanged
    expect(view.getEndDate().getMonth()).toBe(5);
    expect(clone.getEndDate().getMonth()).toBe(6);
  });

  it("should check if date is within interval", () => {
    const view = new ViewDate("month", new Date(2024, 5, 15));
    expect(view.has(new Date(2024, 5, 1))).toBe(true);
    expect(view.has(new Date(2024, 5, 30))).toBe(true);
    expect(view.has(new Date(2024, 6, 1))).toBe(false);
  });

  it("should calculate span from date", () => {
    const view = new ViewDate("month", new Date(2024, 5, 15)); // June
    expect(view.getSpanFrom(new Date(2024, 3, 1))).toBe(2); // April -> June = 2 months
    expect(view.getSpanFrom(new Date(2024, 5, 1))).toBe(0); // Same month
    expect(view.getSpanFrom(new Date(2024, 7, 1))).toBe(-2); // August -> June = -2 months
  });
});

describe("IsDate", () => {
  it("should check if within same month", () => {
    const checker = new IsDate(new Date(2024, 5, 15));
    expect(checker.within("month").from(new Date(2024, 5, 1))).toBe(true);
    expect(checker.within("month").from(new Date(2024, 5, 30))).toBe(true);
    expect(checker.within("month").from(new Date(2024, 6, 1))).toBe(false);
  });

  it("should check if within same year", () => {
    const checker = new IsDate(new Date(2024, 5, 15));
    expect(checker.within("year").from(new Date(2024, 0, 1))).toBe(true);
    expect(checker.within("year").from(new Date(2024, 11, 31))).toBe(true);
    expect(checker.within("year").from(new Date(2023, 5, 15))).toBe(false);
  });
});
