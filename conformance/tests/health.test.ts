import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "../harness";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

describe("GET /health", () => {
  test("answers anyone with the database check", async () => {
    const before = Date.now();
    const result = await stack.anonymous().get<{ healthy: boolean; checks: Record<string, string>; timestamp: number }>("/health");
    expect(result.status).toBe(200);
    expect(result.json.status).toBe("success");
    expect(result.body.healthy).toBe(true);
    expect(result.body.checks).toEqual({ database: "ok" });
    expect(result.body.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.body.timestamp).toBeLessThanOrEqual(Date.now());
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(result.setCookies).toEqual([]);
  });
});
