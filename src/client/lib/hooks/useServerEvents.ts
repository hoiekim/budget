import { useEffect, useRef } from "react";
import { TableName } from "common/constants";

export type ServerEventDomain = TableName;

export interface ServerEventPayload {
  originTabId?: string;
}

export type ServerEventHandler = (
  domain: ServerEventDomain,
  payload: ServerEventPayload,
) => void;

const RECONNECT_BASE_MS = 1_000;

/**
 * Ceiling on the backoff *base*, not on the delay: the jitter band below
 * multiplies it by up to 1.5, so the longest gap between two attempts is
 * `RECONNECT_MAX_BASE_MS * 1.5`.
 */
const RECONNECT_MAX_BASE_MS = 30_000;

/**
 * Consecutive *fatal* closes before the hook stops trying. A fatal close is a
 * non-2xx response — an expired session is the common one — and none of those
 * can succeed until the user logs in again, so retrying forever would be one
 * request per tab per attempt against a server that will keep saying no. The
 * effect re-runs on the auth transition anyway.
 *
 * Deliberately does NOT bound the transport shape (a dropped 200). A server
 * that is merely down comes back, and the browser's own retry recovers that
 * case on its own — so a ceiling there would make an outage longer than the
 * horizon permanently deafen the tab, which is the bug in #669 by another
 * road. The transport shape retries at the capped backoff indefinitely.
 */
const RECONNECT_MAX_FATAL_ATTEMPTS = 10;

/** An open that survives this long counts as recovered and clears the backoff. */
const STABLE_CONNECTION_MS = 60_000;

/**
 * Floor between two reconnect-driven `onReconnect` calls. `onReconnect` is a
 * whole-app refetch — O(all data), not O(gap) — so a flapping stream must not
 * be able to schedule one per flap. Suppressed calls are deferred to the end
 * of the interval, never dropped: each one stands for a gap during which the
 * server broadcast to an empty subscriber set and buffered nothing, so
 * skipping it loses those events for the life of the tab.
 */
const RESYNC_MIN_INTERVAL_MS = 30_000;

/**
 * `EventSource.CLOSED`. Spelled out because it is read off the instance
 * before `close()` — which sets it unconditionally — and because the global
 * is absent when the connection runs against an injected stub.
 */
const EVENT_SOURCE_CLOSED = 2;

/**
 * Backoff before the next reconnect attempt. Jittered over a full band because
 * every tab of every user is knocked off by the same event (a deploy, a proxy
 * blip) and would otherwise re-subscribe — and re-sync — in the same instant,
 * against a server that has just started.
 */
export const reconnectDelayMs = (attempt: number, random: () => number = Math.random): number => {
  const base = Math.min(RECONNECT_MAX_BASE_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.5 + random()));
};

export interface ServerEventsConnectionOptions {
  onEvent: ServerEventHandler;
  onReconnect?: () => void;
  /** Injection seams for the tests; production uses the globals. */
  createEventSource?: () => EventSource;
  now?: () => number;
  random?: () => number;
}

export interface ServerEventsConnection {
  close: () => void;
}

/**
 * The reconnect state machine, lifted out of the effect so it can be driven
 * directly by a test with a stub `EventSource` and fake timers. The hook below
 * is the only production caller and does nothing but own its lifetime.
 */
export const createServerEventsConnection = (
  options: ServerEventsConnectionOptions,
): ServerEventsConnection => {
  const {
    onEvent,
    onReconnect,
    // withCredentials sends the session cookie; without it the SSE
    // request is anonymous and the server 401s.
    createEventSource = () => new EventSource("/api/events", { withCredentials: true }),
    now = Date.now,
    random = Math.random,
  } = options;

  const domains = Object.values(TableName);
  let source: EventSource | null = null;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let stableTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingResyncTimeout: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let fatalAttempts = 0;
  let everOpened = false;
  let lastResyncAt = 0;
  let disposed = false;

  const runResync = () => {
    lastResyncAt = now();
    onReconnect?.();
  };

  /**
   * Trailing-edge throttle. Inside the interval the call is deferred to the
   * moment the interval expires, and repeat requests collapse into that one
   * pending call rather than queueing or replacing it.
   */
  const requestResync = () => {
    const earliest = lastResyncAt + RESYNC_MIN_INTERVAL_MS;
    const elapsed = now();
    if (elapsed >= earliest) {
      if (pendingResyncTimeout) {
        clearTimeout(pendingResyncTimeout);
        pendingResyncTimeout = null;
      }
      runResync();
      return;
    }
    if (pendingResyncTimeout) return;
    pendingResyncTimeout = setTimeout(() => {
      pendingResyncTimeout = null;
      if (disposed) return;
      runResync();
    }, earliest - elapsed);
  };

  const connect = () => {
    const es = createEventSource();
    source = es;

    for (const domain of domains) {
      es.addEventListener(`${domain}-updated`, (e: MessageEvent) => {
        let payload: ServerEventPayload = {};
        try {
          if (e.data) payload = JSON.parse(e.data) as ServerEventPayload;
        } catch {
          // malformed payload — dispatch with empty
        }
        onEvent(domain, payload);
      });
    }

    es.addEventListener("open", () => {
      fatalAttempts = 0;
      // Clearing the backoff after a stable interval rather than on `open`
      // itself: a proxy that accepts the request and drops the stream seconds
      // later would otherwise restart the delay at ~1s every cycle instead of
      // growing it. (A 429 from the per-user subscriber cap does not reach
      // here at all — it is non-2xx, so it fires `error`, never `open`.)
      stableTimeout = setTimeout(() => {
        attempt = 0;
      }, STABLE_CONNECTION_MS);

      if (everOpened) requestResync();
      everOpened = true;
    });

    es.addEventListener("error", () => {
      if (disposed) return;
      if (stableTimeout) {
        clearTimeout(stableTimeout);
        stableTimeout = null;
      }
      // Read the shape before closing: `close()` sets CLOSED unconditionally,
      // so after it the two cases are indistinguishable. CONNECTING means the
      // browser is about to retry a dropped 200 on its own; CLOSED means it
      // received a non-2xx and has given up.
      const fatal = es.readyState === EVENT_SOURCE_CLOSED;
      // Close in both cases — see the note on the hook. Leaving a CONNECTING
      // stream to the browser would retry it with no backoff and no ceiling,
      // once per few seconds, forever.
      es.close();

      if (fatal && ++fatalAttempts >= RECONNECT_MAX_FATAL_ATTEMPTS) {
        console.warn(
          `SSE stream was refused ${RECONNECT_MAX_FATAL_ATTEMPTS} times in a row; giving up until the next auth change or reload.`,
        );
        return;
      }
      retryTimeout = setTimeout(connect, reconnectDelayMs(attempt++, random));
    });
  };

  connect();

  return {
    close: () => {
      disposed = true;
      if (retryTimeout) clearTimeout(retryTimeout);
      if (stableTimeout) clearTimeout(stableTimeout);
      if (pendingResyncTimeout) clearTimeout(pendingResyncTimeout);
      source?.close();
    },
  };
};

/**
 * One tab-lifetime subscription to `/api/events`. Every domain event the
 * server broadcasts to this user fires `handler(domain, payload)`.
 *
 * The handler receives one `(domain, payload)` call per event. To split
 * dispatch across multiple concerns, switch on `domain` inside a single
 * handler passed to one `useServerEvents` call — extra hook instances
 * would open extra streams and blow past the per-user subscriber cap.
 *
 * `enabled` MUST be false until the user is authenticated. `/api/events`
 * 401s for an anonymous request, and per the EventSource spec a non-2xx
 * response is a fatal close. Gating on `enabled` opens the stream only once
 * authenticated, and the effect re-runs (reconnecting) when auth flips.
 *
 * Reconnection is the hook's job because the browser's own retry has no
 * backoff and no ceiling. The two failure shapes differ, and both are handled
 * here rather than half here and half in the browser:
 *
 * - The server drops an established 200 stream (restart, proxy blip, a
 *   reaped socket). `readyState` stays `CONNECTING` and the browser
 *   re-requests on its own every few seconds, indefinitely — measured at
 *   ~3s in Chromium, since the server sends no `retry:` field.
 * - The response is non-2xx (an expired session 401s). `readyState` goes to
 *   `CLOSED` and the browser gives up for good.
 *
 * So the error handler closes the stream in both cases and owns the retry,
 * which is what puts a backoff on the first shape and a ceiling on the second
 * — only the second, since a server that is merely down does come back. Each
 * re-established stream calls `onReconnect`, because the server buffers
 * nothing and replays nothing: an event emitted while the stream was down
 * reached no one, and only a refetch can close that gap. That call is
 * rate-limited — it is a whole-app refetch, and a flapping stream must not be
 * able to schedule one per flap — but rate-limited on the trailing edge, so a
 * gap that falls inside the interval is reconciled late rather than never.
 */
export const useServerEvents = (
  handler: ServerEventHandler,
  enabled = true,
  onReconnect?: () => void,
): void => {
  // Keep the latest handler in a ref so we don't tear the EventSource
  // down every time the parent re-renders with a new closure.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    if (!enabled) return;

    const connection = createServerEventsConnection({
      onEvent: (domain, payload) => handlerRef.current(domain, payload),
      onReconnect: () => onReconnectRef.current?.(),
    });

    return () => connection.close();
  }, [enabled]);
};
