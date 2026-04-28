import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "./logger";

let consoleErrorSpy: ReturnType<typeof spyOn>;
const originalLogLevel = process.env.LOG_LEVEL;
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.LOG_LEVEL = "error";
  process.env.NODE_ENV = "development";
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("logger.error", () => {
  it("formats Error instances with their message", () => {
    logger.error("boom", undefined, new Error("kaboom"));
    const out = String(consoleErrorSpy.mock.calls[0]?.[0] ?? "");
    expect(out).toContain("kaboom");
    expect(out).not.toContain("[object Object]");
  });

  it("serializes plain object errors instead of [object Object]", () => {
    const plaidLikeError = {
      error_type: "ITEM_ERROR",
      error_code: "ITEM_LOGIN_REQUIRED",
      error_message: "the login details have changed",
    };
    logger.error("Failed to get accounts data", { itemId: "abc" }, plaidLikeError);
    const out = String(consoleErrorSpy.mock.calls[0]?.[0] ?? "");
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("ITEM_LOGIN_REQUIRED");
    expect(out).toContain("ITEM_ERROR");
  });

  it("falls back to String() for primitives", () => {
    logger.error("primitive", undefined, "raw string error");
    const out = String(consoleErrorSpy.mock.calls[0]?.[0] ?? "");
    expect(out).toContain("raw string error");
  });

  it("handles circular object references without throwing", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => logger.error("circular", undefined, circular)).not.toThrow();
    const out = String(consoleErrorSpy.mock.calls[0]?.[0] ?? "");
    expect(out).not.toContain("[object Object]");
  });
});
