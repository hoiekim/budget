import { describe, it, expect, beforeEach, mock, afterEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

// We need to mock fetch before importing alarm
const mockFetch = mock(() => Promise.resolve({ ok: true } as Response));
global.fetch = mockFetch as typeof fetch;

// Dynamically import so we can reset module state between tests
let alarm: typeof import("./alarm");

beforeEach(async () => {
  mockFetch.mockClear();
  // Re-import to reset module-level state
  alarm = await import("./alarm");

afterAll(restoreLeaves);
  alarm.resetAlarmState();
});

afterEach(() => {
  delete process.env.DISCORD_ALARM_WEBHOOK;
});

describe("sendAlarm", () => {
  it("does nothing when DISCORD_ALARM_WEBHOOK is not set", async () => {
    delete process.env.DISCORD_ALARM_WEBHOOK;
    await alarm.sendAlarm("Test", "detail");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends a POST to the webhook URL", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
    await alarm.sendAlarm("Test Error", "Something went wrong");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/webhooks/test");
    expect(options.method).toBe("POST");
  });

  it("respects cooldown — a second alarm on the same key within 60s is suppressed", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
    await alarm.sendAlarm("Error 1", "detail 1");
    await alarm.sendAlarm("Error 1", "detail 2");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("cools down per key — a different title is not suppressed", async () => {
    // Previously one global timestamp gated every source, so the first alarm of
    // any minute silenced all others. Distinct titles are distinct buckets now.
    process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
    await alarm.sendAlarm("Scheduled Sync Failed", "detail 1");
    await alarm.sendAlarm("Item Bad Status", "detail 2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("cools down per explicit key, independently of the title", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
    await alarm.sendAlarm("Client JS Error", "a", "client-error");
    await alarm.sendAlarm("Client JS Error", "b", "client-error");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a client-error flood does NOT suppress unrelated server alarms", async () => {
    // The regression that matters: /api/client-error is unauthenticated, so
    // with a shared bucket one request per minute blinded every server-side
    // alarm — route 5xx, uncaughtException/unhandledRejection, scheduled-sync
    // and Plaid Item failures.
    process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
    for (let i = 0; i < 25; i += 1) {
      await alarm.sendAlarm("Client JS Error", `report ${i}`, "client-error");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1); // the flood itself is capped

    await alarm.sendAlarm("Scheduled Sync Failed", "sync blew up");
    await alarm.sendAlarm("Item Bad Status", "item broke");
    expect(mockFetch).toHaveBeenCalledTimes(3); // both real alarms got through
  });
});