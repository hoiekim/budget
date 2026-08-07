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
const RECONNECT_MAX_MS = 30_000;

/**
 * Consecutive failed attempts before the hook stops trying. A fatal close
 * (non-2xx — an expired session is the common one) repeats forever otherwise,
 * one request per tab per `RECONNECT_MAX_MS`, none of which can succeed until
 * the user logs in again. The effect re-runs on that transition anyway.
 */
const RECONNECT_MAX_ATTEMPTS = 10;

/** An open that survives this long counts as recovered and clears the backoff. */
const STABLE_CONNECTION_MS = 60_000;

/**
 * Floor between two reconnect-driven `onReconnect` calls. `onReconnect` is a
 * whole-app refetch — O(all data), not O(gap) — so a flapping stream must not
 * be able to schedule one per flap.
 */
const RESYNC_MIN_INTERVAL_MS = 30_000;

/**
 * Backoff before the next reconnect attempt. Jittered over a full band because
 * every tab of every user is knocked off by the same event (a deploy, a proxy
 * blip) and would otherwise re-subscribe — and re-sync — in the same instant,
 * against a server that has just started.
 */
export const reconnectDelayMs = (attempt: number, random: () => number = Math.random): number => {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.5 + random()));
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
 * which is what puts the backoff on the first shape and a ceiling on the
 * second. Each re-established stream calls `onReconnect`, because the server
 * buffers nothing and replays nothing: an event emitted while the stream was
 * down reached no one, and only a refetch can close that gap. That call is
 * rate-limited — it is a whole-app refetch, and a flapping stream must not be
 * able to schedule one per flap.
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

    const domains = Object.values(TableName);
    let source: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let stableTimeout: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let everOpened = false;
    let lastResyncAt = 0;
    let disposed = false;

    const connect = () => {
      // withCredentials sends the session cookie; without it the SSE
      // request is anonymous and the server 401s.
      const es = new EventSource("/api/events", { withCredentials: true });
      source = es;

      for (const domain of domains) {
        es.addEventListener(`${domain}-updated`, (e: MessageEvent) => {
          let payload: ServerEventPayload = {};
          try {
            if (e.data) payload = JSON.parse(e.data) as ServerEventPayload;
          } catch {
            // malformed payload — dispatch with empty
          }
          handlerRef.current(domain, payload);
        });
      }

      es.addEventListener("open", () => {
        // Clearing the backoff here rather than on `open` itself: a stream
        // that opens and immediately dies (a reconnect that trips the
        // per-user subscriber cap and gets a 429) would otherwise restart
        // the delay at ~1s every cycle instead of growing.
        stableTimeout = setTimeout(() => {
          attempt = 0;
        }, STABLE_CONNECTION_MS);

        if (everOpened) {
          const now = Date.now();
          if (now - lastResyncAt >= RESYNC_MIN_INTERVAL_MS) {
            lastResyncAt = now;
            onReconnectRef.current?.();
          }
        }
        everOpened = true;
      });

      es.addEventListener("error", () => {
        if (disposed) return;
        if (stableTimeout) {
          clearTimeout(stableTimeout);
          stableTimeout = null;
        }
        // Close in both readyState cases — see the note on the hook. Leaving
        // a CONNECTING stream to the browser would retry it with no backoff
        // and no ceiling, once per few seconds, forever.
        es.close();

        if (attempt >= RECONNECT_MAX_ATTEMPTS) {
          console.warn(
            `SSE stream failed ${RECONNECT_MAX_ATTEMPTS} times in a row; giving up until the next auth change or reload.`,
          );
          return;
        }
        retryTimeout = setTimeout(connect, reconnectDelayMs(attempt++));
      });
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimeout) clearTimeout(retryTimeout);
      if (stableTimeout) clearTimeout(stableTimeout);
      source?.close();
    };
  }, [enabled]);
};
