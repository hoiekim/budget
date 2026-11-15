import { describe, expect, it } from "bun:test";
import { numberToCompactString, pluralize } from "./index";

describe("numberToCompactString", () => {
  it("keeps three significant digits with a magnitude suffix", () => {
    expect(numberToCompactString(1_100_100)).toBe("1.1M");
    expect(numberToCompactString(5_480_216)).toBe("5.48M");
    expect(numberToCompactString(743_327)).toBe("743K");
    expect(numberToCompactString(22_439)).toBe("22.4K");
    expect(numberToCompactString(2_400_000_000)).toBe("2.4B");
  });

  it("leaves small numbers as they are and keeps the sign", () => {
    expect(numberToCompactString(514)).toBe("514");
    expect(numberToCompactString(0)).toBe("0");
    expect(numberToCompactString(-1_500)).toBe("-1.5K");
  });
});

describe("pluralize", () => {
  it("adds an s for every count but one", () => {
    expect(pluralize(1, "budget")).toBe("1 budget");
    expect(pluralize(0, "budget")).toBe("0 budgets");
    expect(pluralize(11, "account")).toBe("11 accounts");
  });
});
