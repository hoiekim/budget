import { describe, it, expect, beforeEach } from "bun:test";
import { TableName } from "common/constants";
import {
  registerSubscriber,
  unregisterSubscriber,
  subscriberCount,
  emitToUser,
  closeAllSubscribers,
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
});
