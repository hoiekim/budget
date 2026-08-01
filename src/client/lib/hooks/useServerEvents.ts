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
 * Backoff before the next reconnect attempt. Jittered because every tab of
 * every user is knocked off by the same event (a deploy, a proxy blip) and
 * would otherwise re-subscribe — and re-sync — in the same instant, against
 * a server that has just started.
 */
export const reconnectDelayMs = (attempt: number, random: () => number = Math.random): number => {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + random() * 0.5));
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
 * Reconnection is the hook's job, not the browser's: `EventSource` gives up
 * for good (`readyState === CLOSED`) whenever the response is non-2xx or the
 * server drops the socket — which is what a restart or a proxy blip looks
 * like — so relying on its native retry leaves every tab silently deaf until
 * a manual reload. Each re-established stream calls `onReconnect`, because
 * the server buffers nothing and replays nothing: an event emitted while the
 * stream was down reached no one, and only a refetch can close that gap.
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
    let attempt = 0;
    let everOpened = false;
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
        attempt = 0;
        if (everOpened) onReconnectRef.current?.();
        everOpened = true;
      });

      es.addEventListener("error", () => {
        // A transient error the browser will itself retry leaves readyState
        // at CONNECTING; only a terminal close is ours to recover from.
        if (es.readyState !== EventSource.CLOSED || disposed) return;
        es.close();
        retryTimeout = setTimeout(connect, reconnectDelayMs(attempt++));
      });
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimeout) clearTimeout(retryTimeout);
      source?.close();
    };
  }, [enabled]);
};
