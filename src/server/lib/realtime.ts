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

/** Gap between `: keepalive` blocks on an otherwise-quiet SSE stream. */
export const SSE_KEEPALIVE_MS = 30_000;

/**
 * How long Bun may let an `/api/events` request idle before reaping it.
 * Bun's default is 10 seconds, so this MUST be raised for a stream that
 * goes quiet between events, and it must outlive the keepalive period —
 * a tick scheduled past the deadline can never refresh the socket. Derived
 * rather than picked so the two cannot drift apart; 3x tolerates one missed
 * tick, and 255 is Bun's ceiling.
 *
 * The clamp and the floor are guards, not error handling: `server.timeout`
 * accepts a fractional or out-of-range value silently (measured on Bun
 * 1.3.14 — 7.5 and 300 both return normally), so a value that drifts below
 * the keepalive would reap the stream with nothing raised anywhere.
 */
export const SSE_IDLE_TIMEOUT_SECONDS = Math.min(
  255,
  Math.floor((SSE_KEEPALIVE_MS / 1000) * 3),
);

const subscribers = new Map<string, Set<Subscriber>>();

export type EmitDomain = TableName;

/**
 * Maps a mutating route's path to the DB table a successful write touches.
 * A GET read on a path that also has a write verb (`/snapshots/holding`,
 * `/transfers`) is excluded by the method gate in `mutationEmitDomain`, not
 * by this table.
 */
const MUTATION_DOMAINS: Record<string, EmitDomain> = {
  "/transaction": TableName.Transactions,
  "/new-transaction": TableName.Transactions,
  "/suggest-category": TableName.Transactions,
  "/split-transaction": TableName.SplitTransactions,
  "/new-split-transaction": TableName.SplitTransactions,
  "/investment-transaction": TableName.InvestmentTransactions,
  "/new-investment-transaction": TableName.InvestmentTransactions,
  "/account": TableName.Accounts,
  "/public-token": TableName.Accounts,
  "/item": TableName.Accounts,
  "/snapshot": TableName.Snapshots,
  "/snapshots/holding": TableName.Snapshots,
  "/resolve-security-snapshot": TableName.Snapshots,
  "/budget": TableName.Budgets,
  "/new-budget": TableName.Budgets,
  "/section": TableName.Sections,
  "/new-section": TableName.Sections,
  "/category": TableName.Categories,
  "/new-category": TableName.Categories,
  "/chart": TableName.Charts,
  "/new-chart": TableName.Charts,
  "/transfers/pair": TableName.TransactionPairs,
  "/transfers": TableName.TransactionPairs,
};

/**
 * The DB table a request mutates, or `null` if it isn't a domain write. A
 * path emits only under a mutating verb — POST, DELETE, or a `/new-*` shell
 * INSERT that a GET performs.
 */
export const mutationEmitDomain = (method: string, path: string): EmitDomain | null => {
  const isMutating = method === "POST" || method === "DELETE" || path.startsWith("/new-");
  if (!isMutating) return null;
  return MUTATION_DOMAINS[path] ?? null;
};

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
