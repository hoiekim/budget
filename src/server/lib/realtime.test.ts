import { describe, it, expect, beforeEach } from "bun:test";
import { TableName } from "common/constants";
import {
  registerSubscriber,
  unregisterSubscriber,
  subscriberCount,
  emitToUser,
  mutationEmitDomain,
  closeAllSubscribers,
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
    // `server.timeout` throws on a fractional or out-of-range value, and the
    // throw lands inside the request handler that opens the stream.
    expect(Number.isInteger(SSE_IDLE_TIMEOUT_SECONDS)).toBe(true);
    expect(SSE_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(SSE_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });
});
