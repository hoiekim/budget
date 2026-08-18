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
  send: (event: string, payload: unknown, id?: string) => void;
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

/**
 * One buffered SSE event for reconnect replay. Reconnecting clients
 * request events by id via the browser's Last-Event-ID header; when the
 * ring covers the gap the caller replays these; when it doesn't, the
 * caller emits a `retry-full` signal and the client resyncs.
 *
 * Coverage is bounded by `RING_BUFFER_MAX_ENTRIES` and
 * `RING_BUFFER_MAX_AGE_MS`, whichever hits first. In-memory per process
 * — a multi-instance deployment would move this to Redis or a broker.
 */
export interface StoredEvent {
  /** Monotonic per-user counter. All of a user's tabs share the id
   *  space so any peer emit flows into every subscriber's buffer. */
  id: string;
  domain: EmitDomain;
  payload: EmitPayload;
  timestamp: number;
}

export const RING_BUFFER_MAX_ENTRIES = 512;
export const RING_BUFFER_MAX_AGE_MS = 15 * 60 * 1000;

const perUserBuffer = new Map<string, StoredEvent[]>();
const perUserCounter = new Map<string, number>();

const nextEventId = (userId: string): string => {
  const cur = (perUserCounter.get(userId) ?? 0) + 1;
  perUserCounter.set(userId, cur);
  return String(cur);
};

const appendToBuffer = (userId: string, event: StoredEvent): void => {
  let buf = perUserBuffer.get(userId);
  if (!buf) {
    buf = [];
    perUserBuffer.set(userId, buf);
  }
  buf.push(event);
  const cutoff = Date.now() - RING_BUFFER_MAX_AGE_MS;
  while (buf.length > 0 && (buf.length > RING_BUFFER_MAX_ENTRIES || buf[0].timestamp < cutoff)) {
    buf.shift();
  }
};

/**
 * Return the events a reconnecting client asked for, or the signal that
 * the client should refetch everything.
 *
 * Semantics:
 *  - `lastEventId === null` → new stream. If the counter is 0 (never
 *    emitted for this user in this process) or the buffer is empty, the
 *    client's most recent state is what the login-time `sync()` already
 *    fetched — covered with no replay. Otherwise (buffer has events, but
 *    the client never received an id) → overflow, because between the
 *    client's `sync()` and this SSE subscribe some peer emit landed and
 *    the client would silently miss it.
 *  - `lastEventId` parses AND `lastId <= counterTip` (client isn't from a
 *    future / restarted-process past) AND the buffer's oldest id is
 *    `<= lastEventId + 1` (no gap) → covered; replay events with
 *    `id > last`.
 *  - Otherwise → overflow; caller emits `retry-full` and the client
 *    resyncs. This covers malformed id, empty buffer with a non-null id,
 *    oldest > last+1, AND the restart case where the process's counter
 *    reset below the client's remembered id.
 */
export const getEventsSince = (
  userId: string,
  lastEventId: string | null,
): { events: StoredEvent[]; overflow: boolean } => {
  const buf = perUserBuffer.get(userId);
  const counterTip = perUserCounter.get(userId) ?? 0;
  if (lastEventId === null) {
    const hasBuffered = !!buf && buf.length > 0;
    return { events: [], overflow: hasBuffered };
  }
  const lastId = Number.parseInt(lastEventId, 10);
  if (!Number.isFinite(lastId)) return { events: [], overflow: true };
  if (lastId > counterTip) return { events: [], overflow: true };
  if (!buf || buf.length === 0) return { events: [], overflow: true };
  const firstStoredId = Number.parseInt(buf[0].id, 10);
  if (firstStoredId > lastId + 1) return { events: [], overflow: true };
  const events = buf.filter((e) => Number.parseInt(e.id, 10) > lastId);
  return { events, overflow: false };
};

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
  if (set.size === 0) {
    subscribers.delete(userId);
    // Drop buffer + counter on last disconnect — otherwise idle users
    // accumulate per-process memory forever (age eviction only fires
    // on the next append, which never comes for a disconnected user).
    perUserBuffer.delete(userId);
    perUserCounter.delete(userId);
  }
};

export const subscriberCount = (userId: string): number =>
  subscribers.get(userId)?.size ?? 0;

export const emitToUser = (
  userId: string,
  domain: EmitDomain,
  payload: EmitPayload = {},
): void => {
  // Buffer first so a peer emit landing during a reconnect gap is
  // replayable when the client comes back with Last-Event-ID.
  const id = nextEventId(userId);
  const event: StoredEvent = { id, domain, payload, timestamp: Date.now() };
  appendToBuffer(userId, event);

  const set = subscribers.get(userId);
  if (!set || set.size === 0) return;
  const eventName = `${domain}-updated`;
  for (const sub of set) {
    try {
      sub.send(eventName, payload, id);
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

/** Test hook — clears the ring buffer and id counters. Not called on request paths. */
export const resetRingBufferForTests = (): void => {
  perUserBuffer.clear();
  perUserCounter.clear();
};

/** Test/introspection — how many events are currently buffered for a user. */
export const bufferedEventCount = (userId: string): number =>
  perUserBuffer.get(userId)?.length ?? 0;
