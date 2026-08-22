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

/** Slots a recurring source may take — the ceiling minus the single-shot reserve. */
const recurringCeiling = (): number =>
  alarm.MAX_SENDS_PER_WINDOW - alarm.SINGLE_SHOT_RESERVE;

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

  it("caps recurring sends per window when many distinct keys fire at once", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    // Route.execute keys on the registered path, so a total outage makes every
    // route its own eligible bucket — the per-key cooldown alone does not bound
    // outbound webhook traffic. Recurring sources stop at the reserve, not at
    // the full ceiling, so a crash still has somewhere to go.
    for (let i = 0; i < 40; i += 1) {
      await alarm.sendAlarm(`Route Error: GET /r${i}`, "boom");
    }
    expect(mockFetch).toHaveBeenCalledTimes(recurringCeiling());
  });

  it("does not spend a cooldown on a key the global ceiling refused", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    for (let i = 0; i < alarm.MAX_SENDS_PER_WINDOW; i += 1) {
      await alarm.sendAlarm(`Route Error: GET /r${i}`, "boom");
    }
    // Offset the refusal from the 10 sends so the window and a wrongly-spent
    // cooldown expire at different instants. Refusing at the same instant lets
    // one advance() clear both, and the assertion below passes either way.
    advance(5_000);
    await alarm.sendAlarm("Scheduled Sync Failed", "dropped by ceiling");
    expect(mockFetch).toHaveBeenCalledTimes(recurringCeiling());

    // Now past the window (the 10 sends are pruned) but still inside the 60s
    // that a cooldown spent at the refusal would have started, so the refused
    // key gets through only if the ceiling branch left its cooldown untouched.
    advance(55_001);
    await alarm.sendAlarm("Scheduled Sync Failed", "now it gets through");
    expect(mockFetch).toHaveBeenCalledTimes(recurringCeiling() + 1);
  });

  it("frees ceiling slots as the window slides", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    for (let i = 0; i < alarm.MAX_SENDS_PER_WINDOW; i += 1) {
      await alarm.sendAlarm(`Route Error: GET /a${i}`, "boom");
    }
    await alarm.sendAlarm("Route Error: GET /blocked", "boom");
    expect(mockFetch).toHaveBeenCalledTimes(recurringCeiling());

    advance(60_001);
    await alarm.sendAlarm("Route Error: GET /blocked", "boom");
    expect(mockFetch).toHaveBeenCalledTimes(recurringCeiling() + 1);
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

describe("single-shot lane", () => {
  it("a recurring flood cannot consume the reserve — a crash alarm still gets through", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    // A broad outage: every route 5xxes into its own bucket and re-competes as
    // the window slides.
    for (let i = 0; i < 40; i += 1) {
      await alarm.sendAlarm(`Route Error: GET /r${i}`, "boom");
    }
    expect(mockFetch).toHaveBeenCalledTimes(recurringCeiling());

    await alarm.sendAlarm("Uncaught Exception", "the crash", "Uncaught Exception", "single-shot");
    expect(mockFetch).toHaveBeenCalledTimes(recurringCeiling() + 1);
  });

  it("single-shot sources may take the full ceiling, and no more", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    for (let i = 0; i < 40; i += 1) {
      await alarm.sendAlarm(`Route Error: GET /r${i}`, "boom");
    }
    for (let i = 0; i < alarm.SINGLE_SHOT_RESERVE; i += 1) {
      await alarm.sendAlarm(`Crash ${i}`, "boom", `Crash ${i}`, "single-shot");
    }
    expect(mockFetch).toHaveBeenCalledTimes(alarm.MAX_SENDS_PER_WINDOW);

    // The reserve is a floor for single-shot sources, not an exemption from the
    // ceiling Discord's own rate limit motivates.
    await alarm.sendAlarm("Crash overflow", "boom", "Crash overflow", "single-shot");
    expect(mockFetch).toHaveBeenCalledTimes(alarm.MAX_SENDS_PER_WINDOW);
  });

  it("both crash paths reach Discord through a recurring flood", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    for (let i = 0; i < 40; i += 1) {
      await alarm.sendAlarm(`Route Error: GET /r${i}`, "boom");
    }
    expect(mockFetch).toHaveBeenCalledTimes(recurringCeiling());

    await alarm.deliverCrashAlarm("Uncaught Exception", new Error("boom"));
    expect(mockFetch).toHaveBeenCalledTimes(recurringCeiling() + 1);

    await alarm.reportCrashAlarm("Unhandled Promise Rejection", new Error("boom"));
    expect(mockFetch).toHaveBeenCalledTimes(recurringCeiling() + 2);
  });

  it("the reserve does not lower the ceiling when only single-shot sources fire", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    for (let i = 0; i < alarm.MAX_SENDS_PER_WINDOW + 5; i += 1) {
      await alarm.sendAlarm(`Crash ${i}`, "boom", `Crash ${i}`, "single-shot");
    }
    expect(mockFetch).toHaveBeenCalledTimes(alarm.MAX_SENDS_PER_WINDOW);
  });
});

describe("formatCrashDetail", () => {
  it("renders an Error's message and stack", () => {
    const error = new Error("pool connect ECONNREFUSED");
    const detail = alarm.formatCrashDetail(error);
    expect(detail).toContain("**Message:** pool connect ECONNREFUSED");
    expect(detail).toContain(error.stack!.slice(0, 40));
  });

  it("stringifies a non-Error value and emits an empty stack block", () => {
    expect(alarm.formatCrashDetail("plain string reason")).toBe(
      "**Message:** plain string reason\n```\n\n```",
    );
  });

  it("truncates the stack at 1000 characters", () => {
    const error = new Error("long");
    error.stack = "x".repeat(5_000);
    expect(alarm.formatCrashDetail(error)).toBe(
      `**Message:** long\n\`\`\`\n${"x".repeat(1000)}\n\`\`\``,
    );
  });
});

describe("deliverCrashAlarm", () => {
  it("waits for a slow webhook to settle before resolving", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    let settled = false;
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve({ ok: true } as Response);
          }, 200),
        ) as Promise<Response>,
    );
    await alarm.deliverCrashAlarm("Uncaught Exception", new Error("boom"));
    expect(settled).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("resolves rather than rejecting when the webhook errors", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    mockFetch.mockImplementation(() => Promise.reject(new Error("network down")));
    expect(
      await alarm.deliverCrashAlarm("Uncaught Exception", new Error("boom")),
    ).toBe(undefined);
  });

  it("gives up on a hung webhook once the bound elapses", async () => {
    process.env.DISCORD_ALARM_WEBHOOK = WEBHOOK;
    mockFetch.mockImplementation(() => new Promise(() => undefined) as Promise<Response>);
    const bound = 50;
    const started = realDateNow();
    await alarm.deliverCrashAlarm("Uncaught Exception", new Error("hang"), bound);
    const elapsed = realDateNow() - started;
    expect(elapsed).toBeGreaterThanOrEqual(bound);
    expect(elapsed).toBeLessThan(alarm.CRASH_ALARM_TIMEOUT_MS);
  });
});
