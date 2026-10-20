import { describe, test, expect, mock, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

const { pg } = createFakePg();

mock.module("pg", () => pg);

const { getEventsRoute } = await import("./get-events");
const { SSE_KEEPALIVE_MS, SSE_IDLE_TIMEOUT_SECONDS, subscriberCount, emitToUser, currentEventId } =
  await import("server");
const { TableName } = await import("common/constants");

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
});
