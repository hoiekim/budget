import { describe, it, expect } from "bun:test";
import { AmountInTime } from "./Chart";

// The pre-fix constructor silently accepted null / Invalid-Date
// `amountAsOf` and propagated them to `getSpanFrom` / other consumers
// via `date.getFullYear()`, which crashed the render with
// "Cannot read properties of null (reading 'getFullYear')".
// These tests pin the invariant that `amountAsOf` is always a VALID
// Date after construction.

describe("AmountInTime — amountAsOf validity invariant", () => {
  it("defaults to a valid Date when init is undefined", () => {
    const a = new AmountInTime();
    expect(a.amountAsOf).toBeInstanceOf(Date);
    expect(isNaN(a.amountAsOf.getTime())).toBe(false);
  });

  it("defaults to a valid Date when init lacks amountAsOf", () => {
    const a = new AmountInTime({ amount: 100 });
    expect(a.amountAsOf).toBeInstanceOf(Date);
    expect(isNaN(a.amountAsOf.getTime())).toBe(false);
    expect(a.amount).toBe(100);
  });

  it(
    "falls back to a valid Date when JSON round-trip left amountAsOf === null " +
      "(Date.prototype.toJSON returns null for Invalid Date)",
    () => {
      const a = new AmountInTime({
        amount: 10,
        // Mirror what a mid-typing save serializes to.
        amountAsOf: null as unknown as Date,
      });
      expect(a.amountAsOf).toBeInstanceOf(Date);
      expect(isNaN(a.amountAsOf.getTime())).toBe(false);
    }
  );

  it("falls back to a valid Date when the passed amountAsOf is an Invalid Date", () => {
    // Reproduces the in-memory local-state shape between keystrokes:
    // `new LocalDate("")` / `new LocalDate("2024-01-")` produce an
    // Invalid Date object (getTime() === NaN).
    const invalid = new Date("");
    expect(isNaN(invalid.getTime())).toBe(true);
    const a = new AmountInTime({ amount: 10, amountAsOf: invalid });
    expect(a.amountAsOf).toBeInstanceOf(Date);
    expect(isNaN(a.amountAsOf.getTime())).toBe(false);
  });

  it("parses a valid ISO string with LocalDate semantics (no UTC drift)", () => {
    const a = new AmountInTime({ amount: 5, amountAsOf: "2024-06-15" as unknown as Date });
    expect(isNaN(a.amountAsOf.getTime())).toBe(false);
    // LocalDate interprets bare YYYY-MM-DD as local midnight; the year
    // is the same in every timezone the CI runners use (UTC/PST/EDT
    // don't cross a year boundary at local midnight on June 15).
    expect(a.amountAsOf.getFullYear()).toBe(2024);
    expect(a.amountAsOf.getMonth()).toBe(5); // June (0-indexed)
    expect(a.amountAsOf.getDate()).toBe(15);
  });

  it("preserves an already-valid Date instance passed as amountAsOf", () => {
    const valid = new Date("2024-06-15T00:00:00Z");
    const a = new AmountInTime({ amount: 5, amountAsOf: valid });
    expect(isNaN(a.amountAsOf.getTime())).toBe(false);
    expect(a.amountAsOf.getTime()).toBe(valid.getTime());
  });
});
