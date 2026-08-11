import { describe, it, expect, jest, beforeEach, afterEach, spyOn } from "bun:test";
import { TableName } from "common/constants";
import {
  reconnectDelayMs,
  createServerEventsConnection,
  type ServerEventDomain,
  type ServerEventPayload,
} from "./useServerEvents";

describe("reconnectDelayMs", () => {
  it("backs off exponentially from one second", () => {
    const mid = () => 0.5; // midpoint of the jitter band
    expect(reconnectDelayMs(0, mid)).toBe(1_000);
    expect(reconnectDelayMs(1, mid)).toBe(2_000);
    expect(reconnectDelayMs(2, mid)).toBe(4_000);
    expect(reconnectDelayMs(3, mid)).toBe(8_000);
  });

  it("caps the backoff so a long outage still retries", () => {
    const mid = () => 0.5;
    expect(reconnectDelayMs(10, mid)).toBe(30_000);
    expect(reconnectDelayMs(100, mid)).toBe(30_000);
  });

  it("spreads a herd across a full backoff period, not a fraction of one", () => {
    // Every tab is knocked off by the same deploy. A band narrower than the
    // delay itself returns them in a clump: ±25% of the first attempt spread
    // the herd over 500ms, which is no spread at all against a server that
    // has just started.
    expect(reconnectDelayMs(0, () => 0)).toBe(500);
    expect(reconnectDelayMs(0, () => 1)).toBe(1_500);
    expect(reconnectDelayMs(10, () => 0)).toBe(15_000);
    expect(reconnectDelayMs(10, () => 1)).toBe(45_000);
  });

  it("never returns a delay short enough to hammer the server", () => {
    for (let attempt = 0; attempt <= 12; attempt++) {
      expect(reconnectDelayMs(attempt, () => 0)).toBeGreaterThanOrEqual(500);
    }
  });

  it("treats a negative attempt as the first one", () => {
    expect(reconnectDelayMs(-1, () => 0.5)).toBe(1_000);
  });
});

/**
 * Stands in for the browser's `EventSource`. The two failure shapes differ
 * only by `readyState` at the moment `error` fires, and the state machine
 * branches on exactly that, so the stub exposes one driver per shape:
 * `dropStream()` is a server-closed 200 (CONNECTING — the browser would retry
 * on its own), `refuse()` is a non-2xx (CLOSED — the browser has given up).
 */
class StubEventSource {
  readyState = 0;
  closed = false;
  private listeners = new Map<string, ((e: unknown) => void)[]>();

  addEventListener(type: string, fn: (e: unknown) => void) {
    const forType = this.listeners.get(type) ?? [];
    forType.push(fn);
    this.listeners.set(type, forType);
  }

  close() {
    this.readyState = 2;
    this.closed = true;
  }

  private dispatch(type: string, event: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  open() {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  /** Server closed an established 200 stream. */
  dropStream() {
    this.readyState = 0;
    this.dispatch("error", {});
  }

  /** Server answered non-2xx (401 on an expired session, 429 over the cap). */
  refuse() {
    this.readyState = 2;
    this.dispatch("error", {});
  }

  emit(domain: ServerEventDomain, payload: ServerEventPayload) {
    this.dispatch(`${domain}-updated`, { data: JSON.stringify(payload) });
  }
}

const harness = () => {
  const sources: StubEventSource[] = [];
  const syncs: number[] = [];
  const received: [ServerEventDomain, ServerEventPayload][] = [];
  let clock = 1_000_000;

  const connection = createServerEventsConnection({
    onEvent: (domain, payload) => received.push([domain, payload]),
    onReconnect: () => syncs.push(clock),
    createEventSource: () => {
      const stub = new StubEventSource();
      sources.push(stub);
      return stub as unknown as EventSource;
    },
    now: () => clock,
    random: () => 0.5, // midpoint of the jitter band: delay === base
  });

  return {
    sources,
    syncs,
    received,
    connection,
    latest: () => sources[sources.length - 1],
    advance: (ms: number) => {
      clock += ms;
      jest.advanceTimersByTime(ms);
    },
  };
};

/** Drop the live stream and let the backoff bring the next one up. */
const flap = (h: ReturnType<typeof harness>, backoffMs: number) => {
  h.latest().dropStream();
  h.advance(backoffMs);
  h.latest().open();
};

describe("createServerEventsConnection", () => {
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    jest.useRealTimers();
  });

  it("delivers a domain event to the handler", () => {
    const h = harness();
    h.latest().open();
    h.latest().emit(TableName.Accounts, { originTabId: "tab-a" });
    expect(h.received).toEqual([[TableName.Accounts, { originTabId: "tab-a" }]]);
    h.connection.close();
  });

  it("does not resync on the first open, only on a re-established stream", () => {
    const h = harness();
    h.latest().open();
    expect(h.syncs).toHaveLength(0);
    flap(h, 1_000);
    expect(h.syncs).toHaveLength(1);
    h.connection.close();
  });

  it("reconciles a gap that closes inside the throttle window instead of dropping it", () => {
    // The server buffers and replays nothing, so every gap needs its own
    // refetch. A leading-edge throttle discards the suppressed call and the
    // events from that gap are never reconciled — the tab renders stale data
    // with no error, which is #669 reached by another road.
    const h = harness();
    h.latest().open();

    flap(h, 1_000); // first reconnect: fires immediately
    expect(h.syncs).toHaveLength(1);

    flap(h, 2_000); // second gap, 2s later — inside the 30s window
    expect(h.syncs).toHaveLength(1);

    h.advance(27_999);
    expect(h.syncs).toHaveLength(1);
    h.advance(1);
    expect(h.syncs).toHaveLength(2); // deferred to the end of the window, not dropped

    h.connection.close();
  });

  it("collapses repeated reconnects inside one window into a single deferred resync", () => {
    const h = harness();
    h.latest().open();

    flap(h, 1_000);
    expect(h.syncs).toHaveLength(1);

    flap(h, 2_000);
    flap(h, 4_000);
    flap(h, 8_000);
    expect(h.syncs).toHaveLength(1);

    h.advance(30_000);
    expect(h.syncs).toHaveLength(2); // one, not three

    h.connection.close();
  });

  it("keeps retrying a dropped stream indefinitely, past the fatal ceiling", () => {
    // A server that is merely down comes back. Capping this shape would leave
    // a tab permanently deaf after an outage longer than the horizon — on
    // upstream/main the browser's own retry recovered this case.
    const h = harness();
    h.latest().open();

    for (let i = 0; i < 15; i++) {
      h.latest().dropStream();
      h.advance(60_000); // past the longest possible backoff
    }

    expect(h.sources).toHaveLength(16);
    expect(warn).not.toHaveBeenCalled();
    h.connection.close();
  });

  it("gives up after ten consecutive refusals, which no retry can fix", () => {
    const h = harness();

    for (let i = 0; i < 12; i++) {
      h.latest().refuse();
      h.advance(60_000);
    }

    expect(h.sources).toHaveLength(10);
    expect(warn).toHaveBeenCalled();
    h.connection.close();
  });

  it("clears the refusal count on a stream that opens", () => {
    const h = harness();

    for (let i = 0; i < 9; i++) {
      h.latest().refuse();
      h.advance(60_000);
    }
    expect(h.sources).toHaveLength(10);

    h.latest().open();

    for (let i = 0; i < 9; i++) {
      h.latest().refuse();
      h.advance(60_000);
    }
    expect(h.sources).toHaveLength(19); // not stopped at the ceiling
    expect(warn).not.toHaveBeenCalled();

    h.connection.close();
  });

  it("grows the backoff across dropped streams rather than restarting it", () => {
    const h = harness();
    h.latest().open();

    h.latest().dropStream();
    h.advance(999);
    expect(h.sources).toHaveLength(1);
    h.advance(1);
    expect(h.sources).toHaveLength(2);

    h.latest().dropStream();
    h.advance(1_999);
    expect(h.sources).toHaveLength(2);
    h.advance(1);
    expect(h.sources).toHaveLength(3);

    h.connection.close();
  });

  it("resets the backoff only once a stream has held for the stable interval", () => {
    const h = harness();
    h.latest().open();

    flap(h, 1_000); // attempt 0 consumed
    h.advance(60_000); // this stream held: backoff resets to attempt 0

    h.latest().dropStream();
    h.advance(999);
    expect(h.sources).toHaveLength(2);
    h.advance(1);
    expect(h.sources).toHaveLength(3); // 1s again, not 2s

    h.connection.close();
  });

  it("cancels a deferred resync when the connection is torn down", () => {
    const h = harness();
    h.latest().open();

    flap(h, 1_000);
    flap(h, 2_000); // deferred
    expect(h.syncs).toHaveLength(1);

    h.connection.close();
    h.advance(60_000);
    expect(h.syncs).toHaveLength(1);
  });

  it("closes the live stream and stops reconnecting once torn down", () => {
    const h = harness();
    h.latest().open();
    const live = h.latest();

    h.connection.close();
    expect(live.closed).toBe(true);

    live.dropStream();
    h.advance(60_000);
    expect(h.sources).toHaveLength(1);
  });
});
