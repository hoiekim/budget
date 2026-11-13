// Run with: bun test --preload ./scripts/test-preload.ts reorder.test.ts
import { describe, expect, it } from "bun:test";
import { compareByOrder } from "./reorder";

describe("compareByOrder", () => {
  it("keeps known ids in their stored order", () => {
    const order = ["b", "a", "c"];
    expect(["a", "b", "c"].sort((a, b) => compareByOrder(order, a, b))).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("sorts unknown ids last", () => {
    const order = ["b", "a"];
    expect(["x", "a", "b"].sort((a, b) => compareByOrder(order, a, b))).toEqual([
      "b",
      "a",
      "x",
    ]);
  });

  it("keeps unknown ids in their existing relative order", () => {
    const order = ["a"];
    expect(["x", "y", "a"].sort((a, b) => compareByOrder(order, a, b))).toEqual([
      "a",
      "x",
      "y",
    ]);
  });

  it("leaves the order unchanged when the list is empty", () => {
    expect(["c", "a", "b"].sort((a, b) => compareByOrder([], a, b))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("compares against the -1 sentinel, not undefined", () => {
    const order = ["a"];
    expect(compareByOrder(order, "x", "a")).toBe(1);
    expect(compareByOrder(order, "a", "x")).toBe(-1);
    expect(compareByOrder(order, "x", "y")).toBe(0);
    expect(compareByOrder(order, "a", "a")).toBe(0);
  });
});
