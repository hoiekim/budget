import { describe, expect, it } from "bun:test";
import { flatten } from "./object";

describe("flatten", () => {
  it("should flatten a simple object", () => {
    const input = { a: 1, b: "hello", c: true };
    const result = flatten(input);
    expect(result).toEqual({ a: 1, b: "hello", c: true });
  });

  it("should flatten nested objects with dot notation", () => {
    const input = {
      user: {
        name: "John",
        age: 30,
      },
    };
    const result = flatten(input);
    expect(result).toEqual({
      "user.name": "John",
      "user.age": 30,
    });
  });

  it("should handle deeply nested objects", () => {
    const input = {
      level1: {
        level2: {
          level3: {
            value: "deep",
          },
        },
      },
    };
    const result = flatten(input);
    expect(result).toEqual({
      "level1.level2.level3.value": "deep",
    });
  });

  it("should handle null values", () => {
    const input = { a: null, b: 1 };
    const result = flatten(input);
    expect(result).toEqual({ a: null, b: 1 });
  });

  it("should preserve arrays as-is", () => {
    const input = { items: [1, 2, 3] };
    const result = flatten(input);
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it("should handle boolean values", () => {
    const input = { active: true, disabled: false };
    const result = flatten(input);
    expect(result).toEqual({ active: true, disabled: false });
  });

  it("should handle mixed types in nested objects", () => {
    const input = {
      config: {
        enabled: true,
        count: 42,
        name: "test",
        data: null,
      },
    };
    const result = flatten(input);
    expect(result).toEqual({
      "config.enabled": true,
      "config.count": 42,
      "config.name": "test",
      "config.data": null,
    });
  });

  it("should handle empty object", () => {
    const result = flatten({});
    expect(result).toEqual({});
  });

  it("should handle objects with array values at nested levels", () => {
    const input = {
      user: {
        tags: ["admin", "user"],
      },
    };
    const result = flatten(input);
    expect(result).toEqual({
      "user.tags": ["admin", "user"],
    });
  });
});
