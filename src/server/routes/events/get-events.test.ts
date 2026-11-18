import { describe, test, expect, mock, afterAll, jest } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { startFakeIssuer } from "test-issuer";

const { driver, mockUnsafe } = createFakeSql();

mock.module("../../lib/postgres/sql-driver", () => driver);

const { getEventsRoute } = await import("./get-events");
const { SSE_KEEPALIVE_MS, SSE_IDLE_TIMEOUT_SECONDS, subscriberCount, emitToUser, currentEventId } =
  await import("server");
const { TableName } = await import("common/constants");
const { closeSubscribers } = await import("server/lib/realtime");
const { SESSION_WATCH_INTERVAL_MS } = await import("server/lib/session");
const { configureSso } = await import("server/lib/sso");

const issuer = startFakeIssuer();

afterAll(() => {
  configureSso(null);
  issuer.stop();
  restoreLeaves();
});

/**
 * Hands the route an already-aborted signal. Per the DOM spec
 * `addEventListener("abort", …)` on a settled signal never fires, which the
 * route handles by short-circuiting `start` — so the stream closes without
 * registering a subscriber or arming a keepalive interval, and the test
 * leaves nothing running. `setIdleTimeout` is called before any of that.
 */
const makeReq = (setIdleTimeout: (seconds: number) => void) => {
  const controller = new AbortController();
  controller.abort();
  return {
    method: "GET",
    path: "/events",
    url: "http://x/api/events",
    headers: {},
    query: {},
    body: undefined,
    session: {
      id: "s-1",
      user: { user_id: "u-1", username: "test" },
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
    signal: controller.signal,
    setIdleTimeout,
  } as unknown as Parameters<typeof getEventsRoute.execute>[0];
};

const fakeRes = () =>
  ({
    statusCode: 200,
    headersSent: false,
    status() {
      return this;
    },
    write() {
      return true;
    },
    end() {},
  }) as unknown as Parameters<typeof getEventsRoute.execute>[1];

/** A request whose stream stays open until the returned `close` aborts it. */
const makeLiveReq = (userId: string, query: Record<string, string>) => {
  const controller = new AbortController();
  const req = {
    ...makeReq(() => {}),
    query,
    session: {
      id: "s-live",
      user: { user_id: userId, username: "test" },
      regenerate() {},
      destroy() {},
    },
    signal: controller.signal,
  } as unknown as Parameters<typeof getEventsRoute.execute>[0];
  return { req, close: () => controller.abort() };
};

/** Reads the stream up to and including the `connected` block. */
const readUntilConnected = async (response: Response): Promise<string> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: connected")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text;
};

describe("get-events", () => {
  test("widens this request's idle deadline past the keepalive period", async () => {
    // Deleting the `req.setIdleTimeout(...)` line leaves typecheck clean and
    // every other test green, but the stream then dies at ~12s with no error
    // anywhere. Making the field required on `ServerRequest` proves the
    // plumbing exists, not that this route uses it.
    const calls: number[] = [];
    const result = await getEventsRoute.execute(
      makeReq((seconds) => calls.push(seconds)),
      fakeRes(),
    );

    expect(calls).toEqual([SSE_IDLE_TIMEOUT_SECONDS]);
    // A deadline at or under the keepalive period reaps the stream before the
    // tick that would have refreshed it — the pairing is the whole fix.
    expect(calls[0]).toBeGreaterThan(SSE_KEEPALIVE_MS / 1000);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect((result as Response).headers.get("Content-Type")).toBe("text/event-stream");
  });

  test("an aborted request registers no subscriber", async () => {
    const before = subscriberCount("u-1");
    const result = await getEventsRoute.execute(makeReq(() => {}), fakeRes());
    // Drain so the stream's `start` runs to completion.
    await (result as Response).body?.getReader().read();
    expect(subscriberCount("u-1")).toBe(before);
  });

  test("replays from the last-event-id query parameter and ends on the current id", async () => {
    emitToUser("u-replay", TableName.Accounts);
    const seen = currentEventId("u-replay");
    emitToUser("u-replay", TableName.Budgets);
    const tip = currentEventId("u-replay");
    const { req, close } = makeLiveReq("u-replay", { "last-event-id": seen });
    const text = await readUntilConnected((await getEventsRoute.execute(req, fakeRes())) as Response);
    close();

    const blocks = text.split("\n\n").filter((b) => b.startsWith("id:"));
    expect(blocks).toEqual([
      `id: ${tip}\nevent: ${TableName.Budgets}-updated\ndata: {}`,
      `id: ${tip}\nevent: connected\ndata: {}`,
    ]);
  });

  test("a reconnect with nothing missed gets no retry-full, only the current id", async () => {
    const tip = currentEventId("u-quiet");
    const { req, close } = makeLiveReq("u-quiet", { "last-event-id": tip });
    const text = await readUntilConnected((await getEventsRoute.execute(req, fakeRes())) as Response);
    close();

    expect(text).not.toContain("retry-full");
    expect(text).toContain(`id: ${tip}\nevent: connected\ndata: {}`);
  });

  test("with single sign-on off, a stream never re-reads its session", async () => {
    jest.useFakeTimers();
    try {
      const { req, close } = makeLiveReq("u-plain", {});
      await readUntilConnected((await getEventsRoute.execute(req, fakeRes())) as Response);
      mockUnsafe.mockClear();

      jest.advanceTimersByTime(SESSION_WATCH_INTERVAL_MS * 2);
      jest.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockUnsafe).not.toHaveBeenCalled();
      expect(subscriberCount("u-plain")).toBe(1);
      close();
    } finally {
      jest.useRealTimers();
    }
  });

  describe("with single sign-on on", () => {
    const AUTH = { sid: "ses_9", refreshToken: "rt_9", recheckAt: new Date(Date.now() + 600_000) };

    const openSsoStream = async (userId: string) => {
      const { req, close } = makeLiveReq(userId, {});
      req.session.auth = AUTH;
      const response = (await getEventsRoute.execute(req, fakeRes())) as Response;
      await readUntilConnected(response);
      return close;
    };

    test("a stream closes when its sign-in ends at the identity provider", async () => {
      configureSso(issuer.config(), { fetch: issuer.fetch });
      const close = await openSsoStream("u-sso");
      expect(subscriberCount("u-sso")).toBe(1);

      closeSubscribers({ authSid: "ses_9" });
      expect(subscriberCount("u-sso")).toBe(0);
      close();
      configureSso(null);
    });

    test("a stream closes within a minute of its session ending on another copy of the app", async () => {
      configureSso(issuer.config(), { fetch: issuer.fetch });
      jest.useFakeTimers();
      try {
        const close = await openSsoStream("u-watched");
        mockUnsafe.mockClear();

        jest.advanceTimersByTime(SESSION_WATCH_INTERVAL_MS);
        await Promise.resolve();
        jest.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(mockUnsafe.mock.calls[0]?.[0]).toStartWith("SELECT * FROM sessions WHERE session_id = $1");
        expect(subscriberCount("u-watched")).toBe(0);
        close();
      } finally {
        jest.useRealTimers();
        configureSso(null);
      }
    });
  });
});
