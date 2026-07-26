import { Route } from "server/lib/route";
import {
  logger,
  registerSubscriber,
  unregisterSubscriber,
  subscriberCount,
  type Subscriber,
} from "server";

const SSE_KEEPALIVE_MS = 30_000;
// Bound the number of concurrent tabs per user so a bug or abuse can't grow
// the subscriber map without limit. Each sub holds a keepalive timer + stream
// controller. 20 is comfortably above normal (a few tabs + a few devices)
// while still tripping on runaway reconnect loops.
const MAX_SUBSCRIBERS_PER_USER = 20;

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const formatSseBlock = (event: string, payload: unknown): string => {
  const dataLine = `data: ${JSON.stringify(payload)}\n`;
  return `event: ${event}\n${dataLine}\n`;
};

/**
 * GET /events — one long-open Server-Sent Events stream per user tab.
 * Every mutation route emits via `emitToUser(userId, tableName, {originTabId?})`;
 * each open tab's subscriber receives an `event: <table_name>-updated` block
 * and calls the matching sync function on the client. The originating tab
 * filters its own event out by comparing `originTabId`.
 *
 * Returns a raw `Response(ReadableStream, ...)` because the connection stays
 * open for the tab's lifetime. `Route.execute` passes raw Response objects
 * through unmodified — see `handleApiRequest` in `start.ts`.
 */
export const getEventsRoute = new Route("GET", "/events", async (req, res) => {
  const userId = req.session.user!.user_id;

  if (subscriberCount(userId) >= MAX_SUBSCRIBERS_PER_USER) {
    res.status(429);
    return {
      status: "failed",
      message: "Too many open event streams for this user.",
    };
  }

  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let sub: Subscriber | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
    if (sub) {
      unregisterSubscriber(userId, sub);
      sub = null;
    }
    logger.info("SSE unsubscribed", { userId, remaining: subscriberCount(userId) });
    try {
      controllerRef?.close();
    } catch {
      // controller may already be closed by client disconnect
    }
  };

  // Bun exposes the underlying `AbortSignal` on the incoming Request. Our
  // ServerRequest type doesn't carry it through, so we read from the raw
  // Request stashed on the request in start.ts. If the signal is already
  // aborted at handler entry, `addEventListener("abort", ...)` is a no-op
  // (DOM spec) — set `closed` up front so `start` short-circuits before
  // registering a subscriber that would then leak until the first
  // keepalive tick tripped over the closed controller.
  const signal = req.signal;
  if (signal?.aborted) {
    closed = true;
  } else {
    signal?.addEventListener("abort", cleanup);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (closed) {
        try {
          controller.close();
        } catch {
          // already closed
        }
        return;
      }
      // Prime the connection so the browser fires `onopen` immediately and
      // any proxy in front of us commits to streaming rather than buffering.
      controller.enqueue(encoder.encode(": connected\n\n"));

      sub = {
        send: (event, payload) => {
          if (closed) return;
          controller.enqueue(encoder.encode(formatSseBlock(event, payload)));
        },
        close: cleanup,
      };
      registerSubscriber(userId, sub);
      logger.info("SSE subscribed", { userId, total: subscriberCount(userId) });

      // Keep proxies from timing the connection out; also lets the client
      // detect a dead connection via missed pings.
      keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, SSE_KEEPALIVE_MS);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
});
