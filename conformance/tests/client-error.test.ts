import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type ApiClient, type Stack } from "../harness";

let stack: Stack;
let admin: ApiClient;
beforeAll(async () => {
  stack = await startStack();
  admin = await stack.login();
});
afterAll(() => stack.stop());

const report = (body: unknown, ip: string, options: Parameters<ApiClient["request"]>[2] = {}) =>
  admin.request("POST", "/client-error", { body, ...options, headers: { "X-Real-IP": ip, ...options.headers } });

describe("POST /client-error", () => {
  test("refuses an anonymous caller", async () => {
    const result = await stack.anonymous().post("/client-error", { message: "boom" });
    expect(result.status).toBe(401);
    expect(stack.upstream.discord.posts()).toHaveLength(0);
  });

  test("forwards a report to the alarm webhook", async () => {
    const before = Date.now();
    const result = await report(
      { message: "TypeError: x is undefined", stack: "at render (app.js:1:2)\nat main (app.js:9:9)", url: "https://budget.example.test/accounts" },
      "10.6.0.1",
    );
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success" });
    const posts = stack.upstream.discord.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe("POST");
    expect(posts[0].headers["content-type"]).toBe("application/json");
    const [embed] = stack.upstream.discord.alarms();
    expect(Object.keys(posts[0].json as object)).toEqual(["embeds"]);
    expect(embed.title).toBe("🚨 Budget Server Error: Client JS Error");
    expect(embed.description).toBe(
      "**URL:** https://budget.example.test/accounts\n**Message:** TypeError: x is undefined\n```\nat render (app.js:1:2)\nat main (app.js:9:9)\n```",
    );
    expect(embed.color).toBe(16711680);
    const sentAt = Date.parse(embed.timestamp);
    expect(sentAt).toBeGreaterThanOrEqual(before - 1000);
    expect(sentAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("sends one alarm a minute however many reports arrive, and still answers success", async () => {
    const sent = stack.upstream.discord.posts().length;
    for (const body of [{ message: "second" }, { message: "third" }]) {
      expect((await report(body, "10.6.0.2")).json).toEqual({ status: "success" });
    }
    expect(stack.upstream.discord.posts()).toHaveLength(sent);
  });

  test("accepts any body shape, falling back field by field", async () => {
    const send = (body: unknown, contentType = "application/json") =>
      admin.request("POST", "/client-error", {
        rawBody: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "Content-Type": contentType, "X-Real-IP": "10.6.0.3" },
      });
    for (const body of [
      {},
      { message: 5, stack: {}, url: [] },
      { message: null },
      { stack: "only a stack" },
      { url: "only a url" },
      null,
      [],
      "a string",
      42,
      "{not json",
    ]) {
      const result = await send(body);
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ status: "success" });
    }
    expect((await send("message=plain", "text/plain")).json).toEqual({ status: "success" });
    expect((await admin.request("POST", "/client-error", { headers: { "X-Real-IP": "10.6.0.3" } })).json).toEqual({ status: "success" });
  });

  test("sheds the thirteenth report from one address, before reading it", async () => {
    for (let i = 0; i < 12; i++) expect((await report({ message: `m${i}` }, "10.6.1.1")).status).toBe(200);
    const shed = await report({ message: "one too many" }, "10.6.1.1");
    expect(shed.status).toBe(429);
    expect(shed.json).toEqual({ status: "failed", message: "Too many client error reports, try again later" });
    // Another address, even on the same session, still gets through.
    expect((await report({ message: "elsewhere" }, "10.6.1.2")).status).toBe(200);
    // The limit is checked before the session, so an anonymous caller over it is shed rather than refused.
    const anonymous = await stack.anonymous().post("/client-error", { message: "x" }, { headers: { "X-Real-IP": "10.6.1.1" } });
    expect(anonymous.status).toBe(429);
  });
});

describe("POST /client-error alarm content", () => {
  let fresh: Stack;
  let client: ApiClient;
  beforeAll(async () => {
    fresh = await startStack();
    client = await fresh.login();
  });
  afterAll(() => fresh.stop());

  test("leaves out an empty url and stack, names a missing message, and bounds a long stack", async () => {
    await client.post("/client-error", { stack: "s".repeat(1500), message: "" }, { headers: { "X-Real-IP": "10.6.2.1" } });
    const [embed] = fresh.upstream.discord.alarms();
    expect(embed.description).toBe(`**Message:** \n\`\`\`\n${"s".repeat(1000)}\n\`\`\``);
  });

  test("answers success even when the webhook refuses or is unreachable", async () => {
    await fresh.restart();
    client = await fresh.login();
    fresh.upstream.discord.status = 500;
    expect((await client.post("/client-error", { message: "refused" }, { headers: { "X-Real-IP": "10.6.2.2" } })).json).toEqual({ status: "success" });
    await fresh.waitForLog("Discord alarm rejected by webhook");

    await fresh.restart();
    client = await fresh.login();
    fresh.upstream.hub.setDown("discord.com", true);
    expect((await client.post("/client-error", { message: "down" }, { headers: { "X-Real-IP": "10.6.2.3" } })).json).toEqual({ status: "success" });
    await fresh.waitForLog("Failed to send Discord alarm");
    fresh.upstream.hub.setDown("discord.com", false);
  });

  test("sends nothing when no webhook is configured", async () => {
    await fresh.restart({ DISCORD_ALARM_WEBHOOK: undefined });
    client = await fresh.login();
    const before = fresh.upstream.discord.posts().length;
    expect((await client.post("/client-error", { message: "quiet" }, { headers: { "X-Real-IP": "10.6.2.4" } })).json).toEqual({ status: "success" });
    expect(fresh.upstream.discord.posts()).toHaveLength(before);
  });
});
