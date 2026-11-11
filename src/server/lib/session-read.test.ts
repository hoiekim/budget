import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import type { SessionData } from "server/lib/postgres/models/session";

// Mock fetch before importing the module under test, so the alarm POST
// is observable without touching Discord.
const mockFetch = mock(() => Promise.resolve({ ok: true } as Response));
global.fetch = mockFetch as typeof fetch;

let sessionRead: typeof import("./session-read");
let alarm: typeof import("./alarm");

const realDateNow = Date.now;
let now = 1_700_000_000_000;
const advance = (ms: number): void => {
  now += ms;
};

// Capture error-level log lines so the test can assert the fault is
// logged, not just alarmed.
const errorLines: string[] = [];
const realConsoleError = console.error;

afterAll(() => {
  Date.now = realDateNow;
  console.error = realConsoleError;
  restoreLeaves();
});

beforeEach(async () => {
  mockFetch.mockClear();
  mockFetch.mockImplementation(() => Promise.resolve({ ok: true } as Response));
  now = 1_700_000_000_000;
  Date.now = () => now;
  errorLines.length = 0;
  console.error = (...args: unknown[]) => {
    errorLines.push(args.map(String).join(" "));
  };
  process.env.DISCORD_ALARM_WEBHOOK = "https://discord.com/api/webhooks/test";
  sessionRead = await import("./session-read");
  alarm = await import("./alarm");
  alarm.resetAlarmState();
});

afterEach(() => {
  delete process.env.DISCORD_ALARM_WEBHOOK;
  console.error = realConsoleError;
});

const fakeSession = (overrides?: Partial<SessionData>): SessionData => ({
  user: { user_id: "user-1", username: "test-user" } as SessionData["user"],
  cookie: {
    originalMaxAge: 86400000,
    maxAge: 86400000,
    expires: new Date(Date.now() + 86400000),
    httpOnly: true,
    path: "/",
    secure: false,
    sameSite: "strict",
  },
  ...overrides,
});

const alarmBody = (): { title: string; description: string } => {
  const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
  const parsed = JSON.parse(String(options.body));
  const embed = parsed.embeds[0];
  return { title: embed.title as string, description: embed.description as string };
};

describe("readSessionData", () => {
  test("returns the row when the store read succeeds", async () => {
    const session = fakeSession();
    const store = { get: mock(() => Promise.resolve(session)) };

    const result = await sessionRead.readSessionData(store, "sid-1");

    expect(result).toBe(session);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(errorLines.join("\n")).not.toContain("Session store read fault");
  });

  test("returns null when the store has no row, with no log or alarm", async () => {
    const store = { get: mock(() => Promise.resolve(null)) };

    const result = await sessionRead.readSessionData(store, "sid-1");

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(errorLines.join("\n")).not.toContain("Session store read fault");
  });

  test("a store fault logs at error level, alarms, and degrades to null", async () => {
    const store = {
      get: mock(() => Promise.reject(new Error("connection terminated"))),
    };

    const result = await sessionRead.readSessionData(store, "sid-1");

    expect(result).toBeNull();
    expect(errorLines.join("\n")).toContain("Session store read fault");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { title, description } = alarmBody();
    expect(title).toContain("Session Store Read Fault");
    expect(description).toContain("connection terminated");
    // The session id is a bearer-equivalent credential: it must appear
    // in neither the log line nor the alarm.
    expect(errorLines.join("\n")).not.toContain("sid-1");
    expect(description).not.toContain("sid-1");
  });

  test("a brownout alarms once a minute, but every fault is still logged", async () => {
    const store = {
      get: mock(() => Promise.reject(new Error("connection terminated"))),
    };

    await sessionRead.readSessionData(store, "sid-1");
    advance(10_000);
    await sessionRead.readSessionData(store, "sid-2");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(errorLines.filter((line) => line.includes("Session store read fault"))).toHaveLength(2);
  });
});
