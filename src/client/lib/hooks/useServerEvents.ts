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

/**
 * One tab-lifetime `EventSource` to `/api/events`. Every domain event
 * the server broadcasts to this user fires `handler(domain, payload)`.
 * `EventSource` handles reconnection natively; the hook does not.
 *
 * The handler receives one `(domain, payload)` call per event. To split
 * dispatch across multiple concerns, switch on `domain` inside a single
 * handler passed to one `useServerEvents` call — extra hook instances
 * would open extra streams and blow past the per-user subscriber cap.
 *
 * `enabled` MUST be false until the user is authenticated. `/api/events`
 * 401s for an anonymous request, and per the EventSource spec a non-2xx
 * response is a fatal close — the browser does NOT auto-reconnect after
 * it. Opening the stream on mount (before login) would therefore leave
 * a permanently-dead connection that never recovers once the user logs
 * in. Gating on `enabled` opens the stream only once authenticated, and
 * the effect re-runs (reconnecting) when auth flips.
 *
 * `onReconnect` fires on every `open` after the first one on the same
 * stream. The server buffers nothing and replays nothing, so an event
 * emitted while the connection was down reaches no one — the peer must
 * reconcile by refetching once it is back.
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

    // withCredentials sends the session cookie; without it the SSE
    // request is anonymous and the server 401s.
    const source = new EventSource("/api/events", { withCredentials: true });

    const domains = Object.values(TableName);

    const perDomain = new Map<ServerEventDomain, (e: MessageEvent) => void>();
    for (const domain of domains) {
      const listener = (e: MessageEvent) => {
        let payload: ServerEventPayload = {};
        try {
          if (e.data) payload = JSON.parse(e.data) as ServerEventPayload;
        } catch {
          // malformed payload — dispatch with empty
        }
        handlerRef.current(domain, payload);
      };
      source.addEventListener(`${domain}-updated`, listener);
      perDomain.set(domain, listener);
    }

    let opened = false;
    const onOpen = () => {
      if (opened) onReconnectRef.current?.();
      opened = true;
    };
    source.addEventListener("open", onOpen);

    source.addEventListener("error", () => {
      // EventSource auto-reconnects on error; log only when the connection
      // stays broken (readyState === CLOSED means auto-reconnect gave up).
      if (source.readyState === EventSource.CLOSED) {
        console.warn("SSE connection closed and will not auto-reconnect.");
      }
    });

    return () => {
      for (const [domain, listener] of perDomain) {
        source.removeEventListener(`${domain}-updated`, listener);
      }
      source.removeEventListener("open", onOpen);
      source.close();
    };
  }, [enabled]);
};
