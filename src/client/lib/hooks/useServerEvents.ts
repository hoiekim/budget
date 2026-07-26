import { useEffect, useRef } from "react";

/**
 * Data-domain namespace mirrors `EmitDomain` on the server. Kept as a
 * literal union so a typo at a listener registration site is a compile
 * error. Extend when a new domain gets a mutation surface.
 */
export type ServerEventDomain =
  | "accounts"
  | "budgets"
  | "categories"
  | "charts"
  | "holdings"
  | "holding-snapshots"
  | "investment-transactions"
  | "items"
  | "sections"
  | "snapshots"
  | "split-transactions"
  | "transactions"
  | "transfers";

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
 * The handler should compare `payload.originTabId` against this tab's
 * `X-Tab-Id` to filter its own writes (avoids a redundant self-refetch
 * right after `useMutate` already patched local state).
 *
 * EventSource handles reconnection natively — on network drop the
 * browser reopens the connection with exponential backoff. We don't
 * need to wire that ourselves.
 *
 * Consumers register at most one handler per hook call; if a component
 * needs multiple listeners (e.g. Dashboard cares about both `charts`
 * and `budgets`), pass a switch/dispatch inside the single handler.
 * The router-level `App` wires the global dispatcher.
 */
export const useServerEvents = (handler: ServerEventHandler): void => {
  // Keep the latest handler in a ref so we don't tear the EventSource
  // down every time the parent re-renders with a new closure.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    // withCredentials sends the session cookie; without it the SSE
    // request is anonymous and the server 401s.
    const source = new EventSource("/api/events", { withCredentials: true });

    const domains: ServerEventDomain[] = [
      "accounts",
      "budgets",
      "categories",
      "charts",
      "holdings",
      "holding-snapshots",
      "investment-transactions",
      "items",
      "sections",
      "snapshots",
      "split-transactions",
      "transactions",
      "transfers",
    ];

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
      source.close();
    };
  }, []);
};
