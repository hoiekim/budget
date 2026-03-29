import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";

// We need to mock fetch before importing alarm
const mockFetch = mock(() => Promise.resolve({ ok: true } as Response));
global.fetch = mockFetch as typeof fetch;

// Dynamically import so we can reset module state between tests
let alarm: typeof import("./alarm");

beforeEach(async () => {
  mockFetch.mockClear();
  // Re-import to reset module-level state
  alarm = await import("./alarm");
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

  it("respects cooldown — second alarm within 60s is suppressed", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
    await alarm.sendAlarm("Error 1", "detail 1");
    await alarm.sendAlarm("Error 2", "detail 2");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
