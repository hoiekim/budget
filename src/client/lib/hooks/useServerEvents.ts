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
 * Consecutive *fatal* closes — non-2xx responses — before the hook drops into
 * the slow lane below. An expired session is the common one, and no amount of
 * retrying fixes it before the user logs in again, so a tab should stop asking
 * every half minute.
 *
 * Deliberately does NOT bound the transport shape (a dropped 200). A server
 * that is merely down comes back, and the browser's own retry recovers that
 * case on its own — so a ceiling there would make an outage longer than the
 * horizon permanently deafen the tab, which is #669 by another road. The
 * transport shape retries at the capped backoff indefinitely.
 */
const RECONNECT_MAX_FATAL_ATTEMPTS = 10;

/**
 * What the hook does after that many refusals: keep going, far more slowly,
 * rather than stop. Stopping is wrong even for the fatal shape, because "the
 * server said no" is not the same as "the server will always say no" —
 * `sessionStore.get` failing open yields a 401 from a *store* blip, the
 * per-user subscriber cap yields a 429 that clears when a tab closes, and an
 * unhandled route error yields a 500. All three are non-2xx, all three heal on
 * their own, and a tab that has given up renders a normal app that silently
 * never updates again. Once per few minutes costs nothing and removes the
 * whole permanently-deaf class; a genuinely expired session is still only
 * being asked twelve times an hour instead of a hundred.
 */
const RECONNECT_FATAL_SLOW_MS = 300_000;

/**
 * Spread applied to `onReconnect` itself. The reconnect backoff already
 * spreads a herd recovering from a real outage — every tab errors repeatedly
 * while the server is down, so their timers end up scattered across the
 * accumulated delay. It does not spread the *blip* case: one error each, every
 * tab back inside 1.5s, and each firing a whole-app refetch in the same
 * second. Jittering the refetch rather than the reconnect decouples the two.
 */
const RESYNC_JITTER_MS = 2_000;

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
  let warnedExhausted = false;
  let everOpened = false;
  let lastResyncAt = 0;
  let disposed = false;

  const runResync = () => {
    lastResyncAt = now();
    onReconnect?.();
  };

  /**
   * Trailing-edge throttle. Inside the interval the call is deferred to the
   * moment the interval expires; outside it, only the jitter is waited out.
   * Either way it goes through the timer, so repeat requests collapse into the
   * one pending call rather than queueing.
   */
  const requestResync = () => {
    if (pendingResyncTimeout) return;
    const earliest = lastResyncAt + RESYNC_MIN_INTERVAL_MS;
    const wait = Math.max(0, earliest - now()) + Math.round(random() * RESYNC_JITTER_MS);
    pendingResyncTimeout = setTimeout(() => {
      pendingResyncTimeout = null;
      if (disposed) return;
      runResync();
    }, wait);
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
      // Read the "did any prior attempt fail?" facts BEFORE the resets below
      // — the resync guard depends on them. A first `open` that follows one
      // or more refused/dropped attempts stands for a gap during which
      // `emitToUser` broadcast to no live subscriber, and the client only
      // reconciles on reconnect: without this, the initial gap is lost for
      // the life of the tab (a MAX_SUBSCRIBERS_PER_USER 429 or a sessionStore
      // 401 blip is the reachable case). A genuinely clean first open has
      // `attempt === 0 && fatalAttempts === 0` so the existing
      // "first-open-does-not-resync" behaviour holds.
      const hadPriorFailure = attempt > 0 || fatalAttempts > 0;
      fatalAttempts = 0;
      warnedExhausted = false;
      // Clearing the backoff after a stable interval rather than on `open`
      // itself: a proxy that accepts the request and drops the stream seconds
      // later would otherwise restart the delay at ~1s every cycle instead of
      // growing it. (A 429 from the per-user subscriber cap does not reach
      // here at all — it is non-2xx, so it fires `error`, never `open`.)
      stableTimeout = setTimeout(() => {
        attempt = 0;
      }, STABLE_CONNECTION_MS);

      if (everOpened || hadPriorFailure) requestResync();
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

      // One `EventSource` fires at most one `error` once closed, so this is
      // belt-and-braces — but two live retry timers would double the stream
      // count per tab against a 20-subscriber cap, so never leak one.
      if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
      }

      // "Consecutive" has to mean consecutive: a dropped stream in between is
      // evidence the server is reachable and answering, so it clears the count.
      if (fatal) fatalAttempts++;
      else fatalAttempts = 0;

      if (fatalAttempts >= RECONNECT_MAX_FATAL_ATTEMPTS) {
        if (!warnedExhausted) {
          warnedExhausted = true;
          console.warn(
            `SSE stream was refused ${RECONNECT_MAX_FATAL_ATTEMPTS} times in a row; retrying every few minutes instead.`,
          );
        }
        retryTimeout = setTimeout(connect, Math.round(RECONNECT_FATAL_SLOW_MS * (0.5 + random())));
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
 * which is what puts a backoff on the first shape and a far slower cadence on
 * the second — only the second, since a server that is merely down does come
 * back. Neither shape ever stops retrying: a non-2xx is not always a permanent
 * one (a session-store blip, the subscriber cap, a 500 all answer non-2xx and
 * all heal by themselves), and a tab that has stopped renders a normal app
 * that silently never updates again. Each
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
