import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

// `mock.module` is process-global in Bun and `restoreLeaves` only restores the
// `pg` / `bcrypt` leaves, so capture the real modules up front and restore them
// in `afterAll` (the post-plaid-hook.test.ts pattern) to keep these stubs out of
// sibling route tests sharing the process.
const realAlarm = { ...(await import("server/lib/alarm")) };
const realLogger = { ...(await import("server/lib/logger")) };

const mockSendAlarm = mock(async (_title: string, _detail: string, _key?: string) => {});
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

mock.module("server/lib/alarm", () => ({ ...realAlarm, sendAlarm: mockSendAlarm }));
mock.module("server/lib/logger", () => ({ ...realLogger, logger: mockLogger }));

const { postClientErrorRoute } = await import("./client-error");
const { preSessionShedMessage, clientErrorRateLimiter } = await import(
  "server/lib/rate-limit"
);

afterAll(() => {
  mock.module("server/lib/alarm", () => realAlarm);
  mock.module("server/lib/logger", () => realLogger);
  restoreLeaves();
});

beforeEach(() => {
  mockSendAlarm.mockReset();
  mockSendAlarm.mockImplementation(async () => {});
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
});

// The route's limiter holds module-level per-IP counters, so every test takes
// a fresh IP rather than resetting shared state.
let ipCounter = 0;
const nextIp = () => `203.0.113.${++ipCounter}`;

const makeReq = (
  body: unknown,
  ip: string = nextIp(),
): Parameters<typeof postClientErrorRoute.execute>[0] =>
  ({
    method: "POST",
    path: "/client-error",
    url: "http://x/api/client-error",
    headers: {},
    query: {},
    body,
    ip,
  }) as unknown as Parameters<typeof postClientErrorRoute.execute>[0];

const makeRes = (): Parameters<typeof postClientErrorRoute.execute>[1] =>
  ({ status: mock(() => {}), write: mock(() => {}) }) as unknown as Parameters<
    typeof postClientErrorRoute.execute
  >[1];

describe("POST /client-error", () => {
  test("charges the alarm to its own cooldown bucket, not the title's", async () => {
    // Without the explicit third argument the key falls back to the title and
    // client reports would share a cooldown bucket with every server-side alarm.
    await postClientErrorRoute.execute(
      makeReq({ message: "boom", stack: "at foo", url: "http://x/page" }),
      makeRes()
    );

    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
    const [title, detail, key] = mockSendAlarm.mock.calls[0] as [string, string, string];
    expect(key).toBe("client-error");
    expect(key).not.toBe(title);
    expect(detail).toContain("boom");
  });

  test("reports a placeholder message when the body carries no usable fields", async () => {
    await postClientErrorRoute.execute(makeReq({}), makeRes());

    const [, detail] = mockSendAlarm.mock.calls[0] as [string, string, string];
    expect(detail).toContain("(no message)");
  });

  test("ignores non-string fields instead of interpolating them", async () => {
    await postClientErrorRoute.execute(
      makeReq({ message: { toString: () => "evil" }, stack: 42, url: null }),
      makeRes()
    );

    const [, detail, key] = mockSendAlarm.mock.calls[0] as [string, string, string];
    expect(detail).toContain("(no message)");
    expect(detail).not.toContain("42");
    expect(key).toBe("client-error");
  });

  test("truncates a long stack so one report cannot fill the embed", async () => {
    await postClientErrorRoute.execute(
      makeReq({ message: "boom", stack: "x".repeat(5000) }),
      makeRes()
    );

    const [, detail] = mockSendAlarm.mock.calls[0] as [string, string, string];
    expect(detail).not.toContain("x".repeat(1001));
  });

  test("returns success", async () => {
    const result = await postClientErrorRoute.execute(
      makeReq({ message: "boom" }),
      makeRes()
    );
    expect(result).toEqual({ status: "success" });
  });
});

describe("POST /client-error rate limit", () => {
  // The route charges a slot per accepted report; the shed itself happens at
  // the pre-session gate, before the body is read or the session is loaded.
  // Both halves have to line up, so these drive the route and then ask the
  // gate what it would do with the next request from the same IP.
  const shedFor = (ip: string) => preSessionShedMessage("POST", "/client-error", ip);

  test("accepts reports up to the per-IP cap, then sheds before the handler", async () => {
    const ip = nextIp();
    const CAP = 12;

    for (let i = 0; i < CAP; i++) {
      expect(shedFor(ip)).toBeNull();
      const result = await postClientErrorRoute.execute(
        makeReq({ message: `boom ${i}` }, ip),
        makeRes()
      );
      expect(result).toEqual({ status: "success" });
    }
    expect(mockSendAlarm).toHaveBeenCalledTimes(CAP);

    expect(shedFor(ip)).toBe("Too many client error reports, try again later");
  });

  test("the handler itself has no cap — shedding is the gate's job", async () => {
    const ip = nextIp();
    for (let i = 0; i < 12; i++) {
      await postClientErrorRoute.execute(makeReq({ message: "boom" }, ip), makeRes());
    }
    expect(shedFor(ip)).not.toBeNull();

    mockSendAlarm.mockReset();
    mockLogger.warn.mockReset();

    // Invoked directly, as the gate never would, the handler still accepts and
    // fans out: it carries no cap of its own. That is exactly why the shed has
    // to happen upstream, and it is what makes the gate load-bearing rather
    // than a second opinion.
    const result = await postClientErrorRoute.execute(
      makeReq({ message: "past the cap" }, ip),
      makeRes()
    );
    expect(result).toEqual({ status: "success" });
    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test("one flooding IP does not consume another IP's quota", async () => {
    const flooder = nextIp();
    for (let i = 0; i < 13; i++) {
      await postClientErrorRoute.execute(makeReq({ message: "flood" }, flooder), makeRes());
    }
    mockSendAlarm.mockReset();

    const unrelated = nextIp();
    expect(shedFor(flooder)).not.toBeNull();
    expect(shedFor(unrelated)).toBeNull();

    const result = await postClientErrorRoute.execute(
      makeReq({ message: "unrelated client" }, unrelated),
      makeRes()
    );

    expect(result).toEqual({ status: "success" });
    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
  });

  test("the gate leaves an unlimited path alone", () => {
    const ip = nextIp();
    for (let i = 0; i < 20; i++) clientErrorRateLimiter.consume(ip);
    expect(shedFor(ip)).not.toBeNull();
    expect(preSessionShedMessage("POST", "/transactions", ip)).toBeNull();
    expect(preSessionShedMessage("GET", "/client-error", ip)).toBeNull();
  });
});
