/**
 * The life of a client connection, below any one route.
 *
 * - A connection on which nothing is sent or received for 10 seconds is
 *   closed, whether no request ever came or one was answered and the client
 *   kept the connection; the event stream widens its own deadline, so a quiet
 *   stream stays open.
 * - A handler keeps running when its client goes away: what it was writing
 *   is written.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import net from "node:net";
import { PLAID_PRODUCTION_HOST, plaidAccount, startStack, type ApiClient, type Stack } from "../harness";
import { rowOf } from "../harness/seed/accounts";
import { openEventStream } from "../harness/sse";

// The idle timeout is measured in real seconds.
setDefaultTimeout(40_000);

let stack: Stack;
let admin: ApiClient;
beforeAll(async () => {
  stack = await startStack();
  admin = await stack.login();
});
afterAll(() => stack.stop());

const IDLE_TIMEOUT_MS = 10_000;

/**
 * Opens a raw connection, writes `request` if there is one, and resolves with
 * how long after the last byte either way the server closed it, and what it sent.
 */
const timeUntilClosed = (request?: string): Promise<{ silentMs: number; received: string }> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(stack.port, "127.0.0.1");
    let received = "";
    let lastByte = Date.now();
    socket.on("connect", () => {
      lastByte = Date.now();
      if (request) socket.write(request);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      lastByte = Date.now();
    });
    socket.on("close", () => resolve({ silentMs: Date.now() - lastByte, received }));
    socket.on("error", reject);
  });

// The reference server checks its deadlines on a coarse timer, so the close
// comes a few seconds after the deadline at most.
const closedAfterTheIdleTimeout = (silentMs: number) => {
  expect(silentMs).toBeGreaterThanOrEqual(IDLE_TIMEOUT_MS - 1_000);
  expect(silentMs).toBeLessThanOrEqual(IDLE_TIMEOUT_MS + 6_000);
};

describe("idle connections", () => {
  test("are closed about 10 seconds after the last byte, while the event stream stays open", async () => {
    const stream = await openEventStream(admin, { noCompare: true });
    expect(stream.status).toBe(200);
    await stream.next((block) => block.event === "connected");

    const [silent, keptAlive] = await Promise.all([
      // A connection that never sends a request.
      timeUntilClosed(),
      // One that sent a request, was answered, and kept the connection.
      timeUntilClosed(`GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`),
    ]);
    closedAfterTheIdleTimeout(silent.silentMs);
    expect(silent.received).toBe("");
    closedAfterTheIdleTimeout(keptAlive.silentMs);
    expect(keptAlive.received).toStartWith("HTTP/1.1 200 OK\r\n");

    // The stream has been silent as long, and still delivers.
    expect(stream.ended).toBe(false);
    expect((await admin.get("/new-budget")).json.status).toBe("success");
    expect((await stream.nextEvent({ what: "the budgets event" })).event).toBe("budgets-updated");
    await stream.close();
  });
});

describe("a client that goes away", () => {
  test("does not stop the request it was waiting on: the item is still stored and synced", async () => {
    const { public_token, item } = stack.upstream.plaid.createPublicToken({
      products: [],
      accounts: [plaidAccount({ account_id: "gone-client-checking", name: "Gone Client Checking" })],
    });
    // Plaid takes a while to exchange the token; the client gives up first.
    let exchanging!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => (exchanging = resolve));
    const remove = stack.upstream.hub.on(PLAID_PRODUCTION_HOST, async (request) => {
      if (request.path !== "/item/public_token/exchange") return undefined;
      exchanging();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return undefined;
    });
    try {
      const abort = new AbortController();
      const answer = fetch(`${stack.origin}/api/public-token?provider=plaid`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: admin.cookieHeader() },
        body: JSON.stringify({ public_token, institution_id: "ins_gone" }),
        signal: abort.signal,
      });
      await exchangeStarted;
      abort.abort();
      await expect(answer).rejects.toThrow();

      await stack.waitFor(async () => (await rowOf(stack, "accounts", "gone-client-checking")) !== undefined, {
        what: "the account the abandoned request syncs",
      });
      expect(await rowOf(stack, "items", item.item_id)).toMatchObject({ provider: "plaid", institution_id: "ins_gone", status: "ok" });
      expect(await rowOf(stack, "accounts", "gone-client-checking")).toMatchObject({ item_id: item.item_id, name: "Gone Client Checking" });
    } finally {
      remove();
    }
  });
});
