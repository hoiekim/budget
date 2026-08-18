import { describe, it, expect, beforeEach } from "bun:test";
import { TableName } from "common/constants";
import {
  registerSubscriber,
  unregisterSubscriber,
  subscriberCount,
  emitToUser,
  getEventsSince,
  mutationEmitDomain,
  closeAllSubscribers,
  resetRingBufferForTests,
  bufferedEventCount,
  RING_BUFFER_MAX_ENTRIES,
  SSE_KEEPALIVE_MS,
  SSE_IDLE_TIMEOUT_SECONDS,
  type Subscriber,
} from "./realtime";

// Simple recorder subscriber for tests. `send` captures every (event,
// payload) tuple; `close` records the invocation. `throwOnSend` triggers
// the drop-on-failure branch of `emitToUser`.
const makeRecorder = (opts: { throwOnSend?: boolean } = {}): Subscriber & {
  sent: Array<{ event: string; payload: unknown }>;
  closed: boolean;
} => {
  const rec = {
    sent: [] as Array<{ event: string; payload: unknown }>,
    closed: false,
    send(event: string, payload: unknown) {
      if (opts.throwOnSend) throw new Error("send failed");
      rec.sent.push({ event, payload });
    },
    close() {
      rec.closed = true;
    },
  };
  return rec;
};

beforeEach(() => {
  closeAllSubscribers();
  resetRingBufferForTests();
});

describe("realtime", () => {
  it("registerSubscriber tracks count per user", () => {
    const sub = makeRecorder();
    expect(subscriberCount("u1")).toBe(0);
    registerSubscriber("u1", sub);
    expect(subscriberCount("u1")).toBe(1);
    registerSubscriber("u1", makeRecorder());
    expect(subscriberCount("u1")).toBe(2);
    expect(subscriberCount("u2")).toBe(0);
  });

  it("unregisterSubscriber drops the sub without affecting others", () => {
    const a = makeRecorder();
    const b = makeRecorder();
    registerSubscriber("u1", a);
    registerSubscriber("u1", b);
    unregisterSubscriber("u1", a);
    expect(subscriberCount("u1")).toBe(1);
  });

  it("emitToUser fans out to every subscriber of that user only", () => {
    const a = makeRecorder();
    const b = makeRecorder();
    const other = makeRecorder();
    registerSubscriber("u1", a);
    registerSubscriber("u1", b);
    registerSubscriber("u2", other);

    emitToUser("u1", TableName.Charts);

    expect(a.sent).toEqual([{ event: "charts-updated", payload: {} }]);
    expect(b.sent).toEqual([{ event: "charts-updated", payload: {} }]);
    expect(other.sent).toEqual([]);
  });

  it("emitToUser is a no-op when no subscribers exist for the user", () => {
    expect(() => emitToUser("nobody", TableName.Charts)).not.toThrow();
  });

  it("emitToUser forwards the originTabId payload verbatim", () => {
    const rec = makeRecorder();
    registerSubscriber("u1", rec);
    emitToUser("u1", TableName.Transactions, { originTabId: "tab-abc" });
    expect(rec.sent).toEqual([
      { event: "transactions-updated", payload: { originTabId: "tab-abc" } },
    ]);
  });

  it("event name is `<table_name>-updated` for every TableName", () => {
    const rec = makeRecorder();
    registerSubscriber("u1", rec);
    const domains = Object.values(TableName);
    for (const domain of domains) emitToUser("u1", domain);
    const events = rec.sent.map((s) => s.event);
    expect(events).toEqual(domains.map((d) => `${d}-updated`));
  });

  it("a throwing subscriber is dropped and does not block sibling subscribers", () => {
    const throwing = makeRecorder({ throwOnSend: true });
    const healthy = makeRecorder();
    registerSubscriber("u1", throwing);
    registerSubscriber("u1", healthy);

    emitToUser("u1", TableName.Charts);

    // healthy still received the event
    expect(healthy.sent).toEqual([{ event: "charts-updated", payload: {} }]);
    // throwing was closed (drop-on-failure branch)
    expect(throwing.closed).toBe(true);
  });

  it("mutationEmitDomain maps POST/DELETE writes to their table", () => {
    expect(mutationEmitDomain("POST", "/transaction")).toBe(TableName.Transactions);
    expect(mutationEmitDomain("DELETE", "/transaction")).toBe(TableName.Transactions);
    expect(mutationEmitDomain("POST", "/account")).toBe(TableName.Accounts);
    expect(mutationEmitDomain("DELETE", "/account")).toBe(TableName.Accounts);
    expect(mutationEmitDomain("POST", "/budget")).toBe(TableName.Budgets);
    expect(mutationEmitDomain("POST", "/section")).toBe(TableName.Sections);
    expect(mutationEmitDomain("POST", "/category")).toBe(TableName.Categories);
    expect(mutationEmitDomain("POST", "/chart")).toBe(TableName.Charts);
    expect(mutationEmitDomain("POST", "/split-transaction")).toBe(TableName.SplitTransactions);
    expect(mutationEmitDomain("POST", "/investment-transaction")).toBe(
      TableName.InvestmentTransactions,
    );
    expect(mutationEmitDomain("POST", "/snapshot")).toBe(TableName.Snapshots);
  });

  it("mutationEmitDomain treats /new-* shell INSERTs (GET) as mutating", () => {
    expect(mutationEmitDomain("GET", "/new-transaction")).toBe(TableName.Transactions);
    expect(mutationEmitDomain("GET", "/new-budget")).toBe(TableName.Budgets);
    expect(mutationEmitDomain("GET", "/new-chart")).toBe(TableName.Charts);
  });

  it("mutationEmitDomain maps multi-domain writes to their representative table", () => {
    // Linking / unlinking an item creates or removes accounts; a re-sync of the
    // accounts domain refreshes items + holdings together (one GET /accounts).
    expect(mutationEmitDomain("POST", "/public-token")).toBe(TableName.Accounts);
    expect(mutationEmitDomain("DELETE", "/item")).toBe(TableName.Accounts);
    // suggest-category writes transaction labels + rejected categories.
    expect(mutationEmitDomain("POST", "/suggest-category")).toBe(TableName.Transactions);
    // resolving a security snapshot writes into the snapshots table.
    expect(mutationEmitDomain("POST", "/resolve-security-snapshot")).toBe(TableName.Snapshots);
  });

  it("mutationEmitDomain returns null for a GET read on a shared write path", () => {
    // These paths carry both a read (GET) and a write (POST/DELETE) verb — the
    // read must not emit.
    expect(mutationEmitDomain("GET", "/snapshots/holding")).toBeNull();
    expect(mutationEmitDomain("POST", "/snapshots/holding")).toBe(TableName.Snapshots);
    expect(mutationEmitDomain("GET", "/transfers")).toBeNull();
    expect(mutationEmitDomain("DELETE", "/transfers")).toBe(TableName.TransactionPairs);
    expect(mutationEmitDomain("POST", "/transfers/pair")).toBe(TableName.TransactionPairs);
  });

  it("mutationEmitDomain returns null for pure reads and non-domain writes", () => {
    expect(mutationEmitDomain("GET", "/transactions")).toBeNull();
    expect(mutationEmitDomain("GET", "/accounts")).toBeNull();
    // auth / api-keys / validation / logging are not data domains.
    expect(mutationEmitDomain("POST", "/login")).toBeNull();
    expect(mutationEmitDomain("DELETE", "/login")).toBeNull();
    expect(mutationEmitDomain("POST", "/api-keys")).toBeNull();
    expect(mutationEmitDomain("DELETE", "/api-keys")).toBeNull();
    expect(mutationEmitDomain("POST", "/validate-ticker")).toBeNull();
    expect(mutationEmitDomain("POST", "/client-error")).toBeNull();
    // unknown path
    expect(mutationEmitDomain("POST", "/does-not-exist")).toBeNull();
  });

  it("closeAllSubscribers calls close on every registered sub", () => {
    const a = makeRecorder();
    const b = makeRecorder();
    registerSubscriber("u1", a);
    registerSubscriber("u2", b);
    closeAllSubscribers();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(subscriberCount("u1")).toBe(0);
    expect(subscriberCount("u2")).toBe(0);
  });

  it("the SSE idle timeout outlives a keepalive tick", () => {
    expect(SSE_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(SSE_KEEPALIVE_MS / 1000);
  });

  it("the SSE idle timeout is an integer within Bun's accepted range", () => {
    // `server.timeout` accepts a fractional or out-of-range value silently,
    // so nothing at runtime would report a deadline that had drifted under
    // the keepalive. This assertion is the only place that would.
    expect(Number.isInteger(SSE_IDLE_TIMEOUT_SECONDS)).toBe(true);
    expect(SSE_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(SSE_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });
});

describe("ring buffer", () => {
  it("appends every emit to the per-user buffer, even when no subscriber is live", () => {
    // The whole point of the buffer: a reconnect after a gap can replay
    // whatever landed during the gap. Skipping the append on "no subscriber"
    // would reintroduce the pre-buffer silent-drop.
    emitToUser("u1", TableName.Accounts, { originTabId: "tab-a" });
    emitToUser("u1", TableName.Budgets, { originTabId: "tab-b" });
    expect(bufferedEventCount("u1")).toBe(2);
    expect(bufferedEventCount("u2")).toBe(0);
  });

  it("assigns monotonic ids scoped per user — one user's counter does not disturb another's", () => {
    emitToUser("u1", TableName.Accounts);
    emitToUser("u1", TableName.Accounts);
    emitToUser("u2", TableName.Accounts);
    const u1 = getEventsSince("u1", "0");
    const u2 = getEventsSince("u2", "0");
    expect(u1.events.map((e) => e.id)).toEqual(["1", "2"]);
    expect(u2.events.map((e) => e.id)).toEqual(["1"]);
  });

  it("getEventsSince returns everything with id > lastEventId when the buffer covers it", () => {
    emitToUser("u1", TableName.Accounts, { originTabId: "a" });
    emitToUser("u1", TableName.Budgets, { originTabId: "b" });
    emitToUser("u1", TableName.Transactions, { originTabId: "c" });
    const covered = getEventsSince("u1", "1");
    expect(covered.overflow).toBe(false);
    expect(covered.events.map((e) => e.id)).toEqual(["2", "3"]);
    expect(covered.events.map((e) => e.domain)).toEqual([
      TableName.Budgets,
      TableName.Transactions,
    ]);
  });

  it("getEventsSince flags overflow when the client's remembered id sits above the counter tip — the server-restart case", () => {
    // Pre-restart client held id=100. Server restarts (perUserCounter
    // resets to 0), two peer emits fire → buffer=[{id:1},{id:2}]. Without
    // this branch, `filter(e.id > 100)` returns [] AND overflow=false, so
    // events 1 and 2 are silently missed for the life of the tab.
    emitToUser("u1", TableName.Accounts); // counter=1
    emitToUser("u1", TableName.Accounts); // counter=2
    const restart = getEventsSince("u1", "100");
    expect(restart.overflow).toBe(true);
    expect(restart.events).toEqual([]);
  });

  it("getEventsSince flags overflow when the buffer's oldest id has evicted past the requested id", () => {
    resetRingBufferForTests();
    // Simulate: counter has advanced to 200 but the buffer only holds
    // ids 150-200 (older evicted). A client asking for id=100 has lost
    // events 101-149.
    for (let i = 0; i < 200; i++) emitToUser("u1", TableName.Accounts);
    const stale = getEventsSince("u1", "100");
    // With RING_BUFFER_MAX_ENTRIES=512, all 200 fit — pick a scenario
    // that exceeds the cap.
    expect(stale.overflow).toBe(false); // 200 < 512 = still covered
    resetRingBufferForTests();
    for (let i = 0; i < 600; i++) emitToUser("u1", TableName.Accounts);
    // Buffer holds ids 89..600 (evicted the oldest 88). Client asking
    // for id=1 → firstStored 89 > 1+1 → overflow.
    const evicted = getEventsSince("u1", "1");
    expect(evicted.overflow).toBe(true);
  });

  it("getEventsSince flags overflow when lastEventId does not parse", () => {
    emitToUser("u1", TableName.Accounts);
    const result = getEventsSince("u1", "not-a-number");
    expect(result.overflow).toBe(true);
  });

  it("getEventsSince returns covered on a fresh connection with an empty buffer (typical single-tab boot)", () => {
    // No prior emits for this user → login-time `sync()` already carries
    // fresh state and the SSE stream just needs to start listening.
    const result = getEventsSince("u1", null);
    expect(result.overflow).toBe(false);
    expect(result.events).toEqual([]);
  });

  it("getEventsSince flags overflow on a fresh connection when the buffer has events — peer mutation between login-sync and SSE-subscribe would be missed", () => {
    // A second tab / device where tab A's mutation buffered before tab
    // B's SSE subscribed. Tab B's browser sends no Last-Event-ID (never
    // received one). Without this branch, tab B would silently miss the
    // event since the client hook no longer resyncs blindly on `open`.
    emitToUser("u1", TableName.Accounts);
    const result = getEventsSince("u1", null);
    expect(result.overflow).toBe(true);
  });

  it("evicts by count when the buffer exceeds RING_BUFFER_MAX_ENTRIES", () => {
    // Overshoot the cap. The oldest events fall out; the newest window is
    // still coverable and retained.
    const overshoot = 10;
    for (let i = 0; i < RING_BUFFER_MAX_ENTRIES + overshoot; i++) {
      emitToUser("u1", TableName.Accounts);
    }
    expect(bufferedEventCount("u1")).toBe(RING_BUFFER_MAX_ENTRIES);
    // The buffer's oldest id is now `overshoot + 1`. A client asking for
    // an id from before that is overflow.
    const stale = getEventsSince("u1", "1");
    expect(stale.overflow).toBe(true);
    // A client asking for something inside the window is covered.
    const fresh = getEventsSince("u1", String(RING_BUFFER_MAX_ENTRIES));
    expect(fresh.overflow).toBe(false);
    expect(fresh.events).toHaveLength(overshoot);
  });

  it("delivers the id to live subscribers so EventSource can echo it as Last-Event-ID on reconnect", () => {
    const received: Array<{ event: string; id?: string }> = [];
    const sub: Subscriber = {
      send: (event, _payload, id) => received.push({ event, id }),
      close: () => {},
    };
    registerSubscriber("u1", sub);
    emitToUser("u1", TableName.Accounts);
    emitToUser("u1", TableName.Budgets);
    expect(received.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("preserves the buffer past last-subscriber-out so a single-tab reconnect still resolves via Last-Event-ID", () => {
    // The iOS-backgrounding shape: one tab, one subscription, drops on
    // background, reconnects on foreground. Evicting on last-out would
    // regress this to a whole-app resync every foreground.
    const sub: Subscriber = { send: () => {}, close: () => {} };
    registerSubscriber("u1", sub);
    emitToUser("u1", TableName.Accounts);
    unregisterSubscriber("u1", sub);
    const covered = getEventsSince("u1", "1");
    expect(covered.overflow).toBe(false);
    expect(covered.events).toEqual([]);
  });
});
