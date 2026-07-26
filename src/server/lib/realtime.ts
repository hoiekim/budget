import { TableName } from "common/constants";
import { logger } from "./logger";

/**
 * Per-user SSE subscriber registry. Every open browser tab authenticated
 * as user `U` holds one subscription; when a mutation route emits an
 * event via `emitToUser(U, ...)`, every one of `U`'s open tabs
 * receives it — including other tabs from the same session, which is
 * how a change made in tab A propagates to tabs B and C.
 *
 * A `Subscriber` is one open SSE connection. The `send` function writes
 * a formatted `event:`/`data:` block to the underlying `ReadableStream`
 * controller. `close` is called by the connection cleanup path (client
 * disconnect, tab close) and removes the subscriber from the registry.
 */
export interface Subscriber {
  send: (event: string, payload: unknown) => void;
  close: () => void;
}

const subscribers = new Map<string, Set<Subscriber>>();

/**
 * Domain namespaces the emit path speaks. Every domain is a real DB table
 * name (`TableName`) so server and client share one source of truth —
 * see `common/constants.ts`. The client's dispatch table (PR 2) maps
 * a single table event (e.g. `snapshots-updated`) to the client-side
 * shelves it needs to re-sync (`snapshots` + `holdingSnapshots`).
 *
 * Referencing `TableName.X` at emit call sites gives a compile-time
 * check that the string is a real table.
 */
export type EmitDomain = TableName;

export interface EmitPayload {
  /** Opaque tag the originating tab attached via `X-Tab-Id` header — the
   *  emit path echoes it back so the tab that just wrote can filter its
   *  own event out and avoid a redundant self-refetch. */
  originTabId?: string;
}

export const registerSubscriber = (userId: string, sub: Subscriber): void => {
  let set = subscribers.get(userId);
  if (!set) {
    set = new Set();
    subscribers.set(userId, set);
  }
  set.add(sub);
};

export const unregisterSubscriber = (userId: string, sub: Subscriber): void => {
  const set = subscribers.get(userId);
  if (!set) return;
  set.delete(sub);
  if (set.size === 0) subscribers.delete(userId);
};

export const subscriberCount = (userId: string): number =>
  subscribers.get(userId)?.size ?? 0;

/**
 * Broadcast a mutation event to every open tab of a single user. Called
 * from mutation route handlers after the DB write settles — see the
 * follow-up PR for the per-route wiring.
 */
export const emitToUser = (
  userId: string,
  domain: EmitDomain,
  payload: EmitPayload = {},
): void => {
  const set = subscribers.get(userId);
  if (!set || set.size === 0) return;
  const eventName = `${domain}-updated`;
  for (const sub of set) {
    try {
      sub.send(eventName, payload);
    } catch (err) {
      logger.warn("SSE subscriber send failed — dropping", { userId, domain }, err);
      try {
        sub.close();
      } catch {
        // swallow
      }
    }
  }
};

/**
 * Test/shutdown hook — closes every open subscription. Not called on
 * normal request paths.
 */
export const closeAllSubscribers = (): void => {
  for (const set of subscribers.values()) {
    for (const sub of set) {
      try {
        sub.close();
      } catch {
        // swallow
      }
    }
  }
  subscribers.clear();
};
