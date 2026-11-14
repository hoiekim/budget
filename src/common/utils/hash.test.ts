import { describe, expect, test } from "bun:test";
import { hash128 } from "./hash";

describe("hash128", () => {
  test("is 32 hex digits and the same every time for the same text", () => {
    expect(hash128("acct-1\0row")).toMatch(/^[0-9a-f]{32}$/);
    expect(hash128("acct-1\0row")).toBe(hash128("acct-1\0row"));
  });

  test("tells apart texts that differ in one character or only in order", () => {
    const hashes = new Set(["ab", "ba", "abc", "abd", "", "a", "a\0"].map(hash128));
    expect(hashes.size).toBe(7);
  });

  test("has no collisions over many similar rows", () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 20_000; i++) hashes.add(hash128(`acct-1\u00002026-03-02\u0000FUND\u0000Contributions\u0000${i}.00`));
    expect(hashes.size).toBe(20_000);
  });
});
