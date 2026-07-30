import { describe, it, expect, beforeEach, mock, afterEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

// We need to mock fetch before importing alarm
const mockFetch = mock(() => Promise.resolve({ ok: true } as Response));
global.fetch = mockFetch as typeof fetch;

let alarm: typeof import("./alarm");

// The cooldown and the rate window are both wall-clock, so drive Date.now from
// the test to cover expiry without sleeping.
const realDateNow = Date.now;
let now = 1_700_000_000_000;
const advance = (ms: number): void => {
  now += ms;
};

afterAll(() => {
  Date.now = realDateNow;
  restoreLeaves();
});

beforeEach(async () => {
  mockFetch.mockClear();
  mockFetch.mockImplementation(() => Promise.resolve({ ok: true } as Response));
  now = 1_700_000_000_000;
  Date.now = () => now;
  alarm = await import("./alarm");
  alarm.resetAlarmState();
});

afterEach(() => {
  delete process.env.DISCORD_ALARM_WEBHOOK;
});

const WEBHOOK = "https://discord.com/api/webhooks/test";

describe("sendAlarm", () => {
  it("does nothing when DISCORD_ALARM_WEBHOOK is not set", async () => {
    delete process.env.DISCORD_ALARM_WEBHOOK;
    await alarm.sendAlarm("Test", "detail");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends a POST to the webhook URL", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    await alarm.sendAlarm("Test Error", "Something went wrong");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(options.method).toBe("POST");
  });

  it("respects cooldown — a second alarm on the same key within 60s is suppressed", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    await alarm.sendAlarm("Error 1", "detail 1");
    advance(59_000);
    await alarm.sendAlarm("Error 1", "detail 2");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends again on the same key once the cooldown has elapsed", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    await alarm.sendAlarm("Error 1", "detail 1");
    advance(60_001);
    await alarm.sendAlarm("Error 1", "detail 2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("cools down per key — a different title is not suppressed", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    await alarm.sendAlarm("Scheduled Sync Failed", "detail 1");
    await alarm.sendAlarm("Item Bad Status", "detail 2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("cools down per explicit key, independently of the title", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    await alarm.sendAlarm("Client JS Error", "a", "client-error");
    await alarm.sendAlarm("Client JS Error", "b", "client-error");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a client-error flood does NOT suppress unrelated server alarms", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    for (let i = 0; i < 25; i += 1) {
      await alarm.sendAlarm("Client JS Error", `report ${i}`, "client-error");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1); // the flood itself is capped

    await alarm.sendAlarm("Scheduled Sync Failed", "sync blew up");
    await alarm.sendAlarm("Item Bad Status", "item broke");
    expect(mockFetch).toHaveBeenCalledTimes(3); // both real alarms got through
  });

  it("caps total sends per window when many distinct keys fire at once", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    // Route.execute keys on the registered path, so a total outage makes every
    // route its own eligible bucket — the per-key cooldown alone does not bound
    // outbound webhook traffic.
    for (let i = 0; i < 40; i += 1) {
      await alarm.sendAlarm(`Route Error: GET /r${i}`, "boom");
    }
    expect(mockFetch).toHaveBeenCalledTimes(10);
  });

  it("does not spend a cooldown on a key the global ceiling refused", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    for (let i = 0; i < 10; i += 1) {
      await alarm.sendAlarm(`Route Error: GET /r${i}`, "boom");
    }
    await alarm.sendAlarm("Scheduled Sync Failed", "dropped by ceiling");
    expect(mockFetch).toHaveBeenCalledTimes(10);

    // The window clears the 10 sends; the refused key must be eligible again
    // immediately rather than serving a 60s cooldown it never earned.
    advance(60_001);
    await alarm.sendAlarm("Scheduled Sync Failed", "now it gets through");
    expect(mockFetch).toHaveBeenCalledTimes(11);
  });

  it("frees ceiling slots as the window slides", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    for (let i = 0; i < 10; i += 1) {
      await alarm.sendAlarm(`Route Error: GET /a${i}`, "boom");
    }
    await alarm.sendAlarm("Route Error: GET /blocked", "boom");
    expect(mockFetch).toHaveBeenCalledTimes(10);

    advance(60_001);
    await alarm.sendAlarm("Route Error: GET /blocked", "boom");
    expect(mockFetch).toHaveBeenCalledTimes(11);
  });

  it("does not throw when the webhook returns a non-2xx", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    mockFetch.mockImplementation(
      () => Promise.resolve({ ok: false, status: 429 } as Response)
    );
    await alarm.sendAlarm("Rate Limited", "detail");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not throw when fetch rejects", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    mockFetch.mockImplementation(() => Promise.reject(new Error("network down")));
    await alarm.sendAlarm("Network Error", "detail");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("prunes cooldown entries once they can no longer suppress", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    for (let i = 0; i < 5; i += 1) {
      await alarm.sendAlarm(`Route Error: GET /p${i}`, "boom");
    }
    expect(alarm.getCooldownKeyCount()).toBe(5);
    advance(60_001);
    await alarm.sendAlarm("Route Error: GET /p0", "boom");
    expect(alarm.getCooldownKeyCount()).toBe(1);
  });
});
