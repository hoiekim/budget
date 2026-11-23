import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADMIN_PASSWORD, startStack, type Stack } from "../harness";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ env: { NODE_ENV: "production" } });
});
afterAll(() => stack.stop());

const HSTS = "max-age=31536000; includeSubDomains";

describe("the production posture (NODE_ENV=production)", () => {
  test("marks the session cookie Secure and stores it as such", async () => {
    const client = stack.anonymous();
    const result = await client.post("/login", { username: "admin", password: ADMIN_PASSWORD });
    expect(result.setCookies).toHaveLength(1);
    expect(result.setCookies[0]).toMatch(/^session_id=[0-9a-f-]{36}; Max-Age=604800; Path=\/; HttpOnly; SameSite=Strict; Secure$/);
    const row = await stack.db.one("SELECT cookie_secure FROM sessions WHERE session_id = $1", [client.cookies.get("session_id")]);
    expect(row?.cookie_secure).toBe(true);
    const out = await client.delete("/login");
    expect(out.setCookies).toEqual(["session_id=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict; Secure"]);
  });

  test("adds HSTS to responses a route produced, and not to the ones the server shed before routing", async () => {
    const client = await stack.login();
    expect((await client.get("/login")).headers.get("strict-transport-security")).toBe(HSTS);
    expect((await stack.anonymous().get("/health")).headers.get("strict-transport-security")).toBe(HSTS);
    expect((await stack.anonymous().get("/nope")).headers.get("strict-transport-security")).toBeNull();
    expect((await client.get("/nope")).headers.get("strict-transport-security")).toBeNull();
    expect((await stack.anonymous().get("//index.html")).headers.get("strict-transport-security")).toBeNull();
  });

  test("logs one JSON line per API request, with field names but never values", async () => {
    const client = stack.anonymous();
    await client.post("/login", { username: "admin", password: "a-secret-value" }, { headers: { "X-Real-IP": "10.4.0.1" }, query: { probe: "1" } });
    const line = await stack.waitFor(() => stack.logs.find((l) => l.includes('"API request"') && l.includes("10.4.0.1")), {
      what: "the access log line",
    });
    const entry = JSON.parse(line ?? "") as { level: string; message: string; timestamp: string; context: Record<string, unknown> };
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("API request");
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
    expect(entry.context).toMatchObject({
      method: "POST",
      path: "/api/login",
      ip: "10.4.0.1",
      bodyFields: ["username", "password"],
      query: { probe: "1" },
      user: "anonymous",
      status: 200,
    });
    expect(typeof entry.context.durationMs).toBe("number");
    expect(line).not.toContain("a-secret-value");
  });

  test("keeps /health out of the access log", async () => {
    await stack.anonymous().get("/health", { headers: { "X-Real-IP": "10.4.0.2" } });
    await stack.anonymous().get("/login", { headers: { "X-Real-IP": "10.4.0.3" } });
    await stack.waitFor(() => stack.logs.some((l) => l.includes("10.4.0.3")), { what: "the later access log line" });
    expect(stack.logs.some((l) => l.includes("10.4.0.2"))).toBe(false);
  });
});
