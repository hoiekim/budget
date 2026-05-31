import { describe, it, expect } from "bun:test";
import { isApiPath } from "./index";

describe("isApiPath", () => {
  it("matches the literal /api", () => {
    expect(isApiPath("/api")).toBe(true);
  });

  it("matches /api/<anything>", () => {
    expect(isApiPath("/api/health")).toBe(true);
    expect(isApiPath("/api/transactions/12345")).toBe(true);
    expect(isApiPath("/api/")).toBe(true);
  });

  it("rejects /api-<anything> (regression for #391)", () => {
    // SPA routes whose names happen to start with the characters "api".
    expect(isApiPath("/api-key-detail")).toBe(false);
    expect(isApiPath("/apikey-detail")).toBe(false);
    expect(isApiPath("/api-anything")).toBe(false);
  });

  it("rejects unrelated SPA paths", () => {
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/budgets")).toBe(false);
    expect(isApiPath("/budget-detail")).toBe(false);
    expect(isApiPath("/transactions")).toBe(false);
  });
});
