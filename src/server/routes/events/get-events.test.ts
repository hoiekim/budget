import { describe, test, expect, mock, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [] as unknown[],
  rowCount: 0 as number | null,
}));

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
}

mock.module("pg", () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {} },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
}));

const { getEventsRoute } = await import("./get\-events");
const { SSE_KEEPALIVE_MS, SSE_IDLE_TIMEOUT_SECONDS, subscriberCount } = await import("server");

afterAll(restoreLeaves);

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

describe("get-events", () => {
  test("widens this request's idle deadline past the keepalive period", async () => {
    // Deleting the `req.setIdleTimeout(...)` line leaves `bun run typecheck`
    // clean and every other test green, and #669 is back — the stream dies at
    // ~12s with no error anywhere. Making the field required on
    // `ServerRequest` proves the plumbing exists, not that this route uses it.
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
});
