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
/** Chromium's measured native retry cadence for a dropped 200 stream. */
const NATIVE_RETRY_MS = 3_000;

class StubEventSource {
  readyState = 0;
  closed = false;
  nativeRetry: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Map<string, ((e: unknown) => void)[]>();

  addEventListener(type: string, fn: (e: unknown) => void) {
    const forType = this.listeners.get(type) ?? [];
    forType.push(fn);
    this.listeners.set(type, forType);
  }

  close() {
    this.readyState = 2;
    this.closed = true;
    if (this.nativeRetry) {
      clearTimeout(this.nativeRetry);
      this.nativeRetry = null;
    }
  }

  private dispatch(type: string, event: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  open() {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  /**
   * Server closed an established 200 stream. The browser's own retry then
   * re-opens this same `EventSource` a few seconds later unless the hook
   * closed it — modelling that is what makes the `es.close()` in the error
   * handler observable, and without it the hook could drop that line and run
   * two live streams per tab with nothing going red.
   */
  dropStream() {
    this.readyState = 0;
    this.dispatch("error", {});
    this.nativeRetry = setTimeout(() => {
      if (this.closed) return;
      this.open();
    }, NATIVE_RETRY_MS);
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

/** Jitter the harness's midpoint `random` produces on the resync band. */
const RESYNC_JITTER = 1_000;

const harness = (opts: { random?: () => number } = {}) => {
  const sources: StubEventSource[] = [];
  const syncs: number[] = [];
  const received: [ServerEventDomain, ServerEventPayload][] = [];
  let clock = 1_000_000;

  const advance = (ms: number) => {
    clock += ms;
    jest.advanceTimersByTime(ms);
  };

  const connection = createServerEventsConnection({
    onEvent: (domain, payload) => received.push([domain, payload]),
    onReconnect: () => syncs.push(clock),
    createEventSource: () => {
      const stub = new StubEventSource();
      sources.push(stub);
      return stub as unknown as EventSource;
    },
    now: () => clock,
    // Midpoint of every band: the reconnect delay equals its base, and the
    // resync jitter is half of RESYNC_JITTER_MS.
    random: opts.random ?? (() => 0.5),
  });

  return {
    sources,
    syncs,
    received,
    connection,
    latest: () => sources[sources.length - 1],
    advance,
    advanceUntil: (t: number) => advance(Math.max(0, t - clock)),
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
    h.advance(RESYNC_JITTER); // the resync is spread, so it is not synchronous with `open`
    expect(h.syncs).toHaveLength(1);
    h.connection.close();
  });

  it("reconciles the initial gap when the first open follows refused attempts", () => {
    // A tab that opens against `MAX_SUBSCRIBERS_PER_USER = 20` currently held
    // by peer tabs gets a 429 (or a `sessionStore.get` blip yields a 401) on
    // its first `/api/events` request. The browser retries; the first `open`
    // fires after N failed attempts, and a peer mutation landing in that
    // window reached no live subscriber. Without this, `everOpened === false`
    // suppresses the reconcile — for the life of the tab, since nothing else
    // reconciles (see the `Utility.tsx` wiring).
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.latest().refuse();
      h.advance(60_000);
    }
    expect(h.sources).toHaveLength(6);
    h.latest().open();
    h.advance(RESYNC_JITTER);
    expect(h.syncs).toHaveLength(1);
    h.connection.close();
  });

  it("reconciles the initial gap when the first open follows dropped 200s", () => {
    // Same class as above via the transport shape: the server drops the
    // stream mid-negotiation before `open` ever fires. The browser retries;
    // the first `open` after N drops still needs a reconcile because
    // `emitToUser` broadcast to nobody during the drops.
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.latest().dropStream();
      h.advance(60_000);
    }
    expect(h.sources).toHaveLength(4);
    h.latest().open();
    h.advance(RESYNC_JITTER);
    expect(h.syncs).toHaveLength(1);
    h.connection.close();
  });

  it("spreads the resync itself, not just the reconnect that triggers it", () => {
    // The reconnect backoff spreads a herd recovering from a real outage, but
    // not a sub-second blip: every tab errors once, returns inside 1.5s, and
    // fires a whole-app refetch in the same instant.
    const early = harness({ random: () => 0 });
    early.latest().open();
    early.latest().dropStream();
    early.advance(500); // bottom of the reconnect band for attempt 0
    early.latest().open();
    early.advance(0);
    expect(early.syncs).toHaveLength(1); // bottom of the resync band: no wait
    early.connection.close();

    const late = harness({ random: () => 1 });
    late.latest().open();
    late.latest().dropStream();
    late.advance(1_500); // top of the reconnect band for attempt 0
    late.latest().open();
    late.advance(1_999);
    expect(late.syncs).toHaveLength(0);
    late.advance(1);
    expect(late.syncs).toHaveLength(1); // top of the band: a full 2s later
    late.connection.close();
  });

  it("reconciles a gap that closes inside the throttle window instead of dropping it", () => {
    // The server buffers and replays nothing, so every gap needs its own
    // refetch. A leading-edge throttle discards the suppressed call and the
    // events from that gap are never reconciled — the tab renders stale data
    // with no error, which is #669 reached by another road.
    const h = harness();
    h.latest().open();

    flap(h, 1_000); // first reconnect: fires as soon as the jitter is out
    h.advance(RESYNC_JITTER);
    expect(h.syncs).toHaveLength(1);
    const firstAt = h.syncs[0];

    flap(h, 2_000); // second gap, seconds later — inside the 30s window
    expect(h.syncs).toHaveLength(1);

    h.advanceUntil(firstAt + 30_000 + RESYNC_JITTER - 1);
    expect(h.syncs).toHaveLength(1);
    h.advance(1);
    expect(h.syncs).toHaveLength(2); // deferred to the end of the window, not dropped

    h.connection.close();
  });

  it("collapses repeated reconnects inside one window into a single deferred resync", () => {
    const h = harness();
    h.latest().open();

    flap(h, 1_000);
    h.advance(RESYNC_JITTER);
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

  it("drops to a slow cadence after ten consecutive refusals, but never stops", () => {
    // Stopping is wrong even here: a 401 from a session-store blip, a 429 from
    // the subscriber cap and a 500 from a route error are all non-2xx and all
    // heal on their own. A tab that has stopped renders a normal app that
    // silently never updates again.
    const h = harness();

    for (let i = 0; i < 10; i++) {
      h.latest().refuse();
      h.advance(60_000);
    }
    expect(h.sources).toHaveLength(10);
    expect(warn).toHaveBeenCalledTimes(1);

    h.advance(60_000); // way past the fast backoff — the slow lane is longer
    expect(h.sources).toHaveLength(10);

    h.advance(240_000);
    expect(h.sources).toHaveLength(11); // still asking, once per few minutes

    h.latest().refuse(); // and the answer is still no
    h.advance(300_000);
    expect(h.sources).toHaveLength(12);
    expect(warn).toHaveBeenCalledTimes(1); // one warning, not one per cycle

    h.connection.close();
  });

  it("recovers at full speed once a refused stream is finally accepted", () => {
    const h = harness();

    for (let i = 0; i < 10; i++) {
      h.latest().refuse();
      h.advance(60_000);
    }
    h.advance(300_000); // the slow-lane retry lands
    h.latest().open(); // the store blip healed and the stream was accepted
    h.advance(60_000); // and it holds, so the backoff resets too
    const healed = h.sources.length;

    h.latest().dropStream();
    h.advance(1_000);
    expect(h.sources).toHaveLength(healed + 1); // 1s, not 5 minutes

    h.connection.close();
  });

  it("counts only consecutive refusals — a dropped stream clears the count", () => {
    const h = harness();

    for (let i = 0; i < 9; i++) {
      h.latest().refuse();
      h.advance(60_000);
    }
    h.latest().dropStream(); // the server is reachable and answering
    h.advance(60_000);

    for (let i = 0; i < 9; i++) {
      h.latest().refuse();
      h.advance(60_000);
    }
    expect(warn).not.toHaveBeenCalled(); // never reached ten in a row

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
    expect(h.sources).toHaveLength(19); // not slowed at the ceiling
    expect(warn).not.toHaveBeenCalled();

    h.connection.close();
  });

  it("clears the stability timer when the stream dies, so the backoff keeps growing", () => {
    // Without the clear, an open that dies seconds later still resets `attempt`
    // sixty seconds after that open — so an accept-then-drop proxy never grows
    // the delay, which is the whole point of the timer.
    const h = harness();
    h.latest().open(); // stability timer armed here
    h.advance(1_000);

    h.latest().dropStream(); // attempt 0 -> 1
    h.advance(1_000); // reconnect: this stream is never accepted
    expect(h.sources).toHaveLength(2);

    h.advance(59_000); // past the armed timer — it must not fire
    h.latest().dropStream(); // attempt 1 -> 2, so the next delay is 2s

    h.advance(1_000);
    expect(h.sources).toHaveLength(2); // still waiting: 1s would already be up
    h.advance(1_000);
    expect(h.sources).toHaveLength(3);

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
    h.advance(60_000); // this stream held for the stable interval: backoff resets

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
    h.advance(RESYNC_JITTER);
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
