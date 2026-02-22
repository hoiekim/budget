import { describe, expect, it } from "bun:test";
import { Average, cap } from "./math";

describe("Average", () => {
  it("should return 0 for empty average", () => {
    const avg = new Average();
    expect(avg.value).toBe(0);
  });

  it("should calculate average for single value", () => {
    const avg = new Average();
    avg.put(10);
    expect(avg.value).toBe(10);
  });

  it("should calculate average for multiple values", () => {
    const avg = new Average();
    avg.put(10);
    avg.put(20);
    avg.put(30);
    expect(avg.value).toBe(20);
  });

  it("should handle negative numbers", () => {
    const avg = new Average();
    avg.put(-10);
    avg.put(10);
    expect(avg.value).toBe(0);
  });

  it("should handle decimal values", () => {
    const avg = new Average();
    avg.put(1.5);
    avg.put(2.5);
    expect(avg.value).toBe(2);
  });

  it("should merge two averages correctly", () => {
    const avg1 = new Average();
    avg1.put(10);
    avg1.put(20);

    const avg2 = new Average();
    avg2.put(30);
    avg2.put(40);

    avg1.merge(avg2);
    expect(avg1.value).toBe(25); // (10+20+30+40) / 4
  });

  it("should handle merging with empty average", () => {
    const avg1 = new Average();
    avg1.put(10);

    const avg2 = new Average();

    avg1.merge(avg2);
    expect(avg1.value).toBe(10);
  });
});

describe("cap", () => {
  it("should return value when within bounds", () => {
    expect(cap(5, { min: 0, max: 10 })).toBe(5);
  });

  it("should cap to minimum", () => {
    expect(cap(-5, { min: 0, max: 10 })).toBe(0);
  });

  it("should cap to maximum", () => {
    expect(cap(15, { min: 0, max: 10 })).toBe(10);
  });

  it("should work with only min constraint", () => {
    expect(cap(-5, { min: 0 })).toBe(0);
    expect(cap(100, { min: 0 })).toBe(100);
  });

  it("should work with only max constraint", () => {
    expect(cap(100, { max: 50 })).toBe(50);
    expect(cap(-100, { max: 50 })).toBe(-100);
  });

  it("should handle edge case of exact bounds", () => {
    expect(cap(0, { min: 0, max: 10 })).toBe(0);
    expect(cap(10, { min: 0, max: 10 })).toBe(10);
  });

  it("should return value with no constraints", () => {
    expect(cap(42, {})).toBe(42);
  });
});
