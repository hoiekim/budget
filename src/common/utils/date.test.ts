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
