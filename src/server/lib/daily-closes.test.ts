import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { restoreFetch, restoreEnv } from "test-helpers";
import { distributionsFromCloses } from "common";
import {
  adjustForDividends,
  splitAdjust,
  clearDailyClosesCache,
  getDailyCloses,
  peekDailyCloses,
  warmDailyCloses,
} from "./daily-closes";
import { polygonQueue, clearPriceCache } from "./polygon";
import { clearYahooCache, yahooQueue } from "./yahoo";

const yahooTs = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d, 14, 30) / 1000);
// Polygon stamps a daily bar at the session's start in New York, in ms.
const polygonTs = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 5);

type Responder = (url: string) => { status?: number; body: unknown };

const mockFetch = (respond: Responder) => {
  const fetchMock = mock((url: string) => {
    const { status = 200, body } = respond(url);
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) } as Response);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

const yahooChart = (timestamps: number[], closes: Array<number | null>, adjcloses?: Array<number | null>) => ({
  chart: {
    result: [
      {
        timestamp: timestamps,
        indicators: {
          quote: [{ close: closes }],
          ...(adjcloses ? { adjclose: [{ adjclose: adjcloses }] } : {}),
        },
      },
    ],
    error: null,
  },
});

describe("adjustForDividends", () => {
  it("scales every close before an ex-date by one minus the dividend over the prior close", () => {
    const bars = [
      { date: "2026-03-02", close: 100 },
      { date: "2026-03-03", close: 102 },
      { date: "2026-03-04", close: 99 },
    ];
    const adjusted = adjustForDividends(bars, [{ exDate: "2026-03-04", cashAmount: 2.04 }]);
    expect(adjusted.map((b) => b.close)).toEqual([100, 102, 99]);
    expect(adjusted[2].adjustedClose).toBe(99);
    expect(adjusted[1].adjustedClose).toBeCloseTo(102 * (1 - 2.04 / 102), 10);
    expect(adjusted[0].adjustedClose).toBeCloseTo(100 * (1 - 2.04 / 102), 10);
  });

  it("an ex-date on a non-trading day applies at the next bar", () => {
    const bars = [
      { date: "2026-03-06", close: 50 },
      { date: "2026-03-09", close: 49 },
    ];
    const adjusted = adjustForDividends(bars, [{ exDate: "2026-03-07", cashAmount: 1 }]);
    expect(adjusted[0].adjustedClose).toBeCloseTo(49, 10);
    expect(adjusted[1].adjustedClose).toBe(49);
  });

  it("splitAdjust divides a dividend by every split after its ex-date only", () => {
    const splits = [
      { date: "2026-03-10", ratio: 2 },
      { date: "2026-09-10", ratio: 10 },
    ];
    expect(
      splitAdjust(
        [
          { exDate: "2026-03-01", cashAmount: 4 },
          { exDate: "2026-06-01", cashAmount: 4 },
          { exDate: "2026-09-10", cashAmount: 4 },
        ],
        splits,
      ),
    ).toEqual([
      { exDate: "2026-03-01", cashAmount: 0.2 },
      { exDate: "2026-06-01", cashAmount: 0.4 },
      { exDate: "2026-09-10", cashAmount: 4 },
    ]);
  });

  it("carries the dividends the import reads back out of the two series", () => {
    const bars = [
      { date: "2026-03-02", close: 100 },
      { date: "2026-03-03", close: 102 },
      { date: "2026-03-04", close: 99 },
      { date: "2026-06-01", close: 104 },
      { date: "2026-06-02", close: 103.2 },
    ];
    const dividends = [
      { exDate: "2026-03-04", cashAmount: 2.04 },
      { exDate: "2026-06-02", cashAmount: 0.8125 },
    ];
    expect(distributionsFromCloses(adjustForDividends(bars, dividends))).toEqual([
      { ex_date: "2026-03-04", cash_amount: 2.04, close: 99 },
      { ex_date: "2026-06-02", cash_amount: 0.8125, close: 103.2 },
    ]);
  });
});

describe("getDailyCloses", () => {
  beforeEach(() => {
    clearDailyClosesCache();
    clearPriceCache();
    clearYahooCache();
    polygonQueue.reset();
    yahooQueue.reset();
    process.env.POLYGON_RATE_LIMIT_PER_MIN = "0";
    process.env.YAHOO_RATE_LIMIT_PER_MIN = "0";
    process.env.POLYGON_API_KEY = "test-key";
  });

  afterEach(() => {
    restoreEnv();
    restoreFetch();
  });

  it("builds the adjusted series from Polygon's bars and dividends", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/v2/aggs/")) {
        return {
          body: {
            status: "OK",
            results: [
              { c: 100, t: polygonTs(2026, 3, 2) },
              { c: 99, t: polygonTs(2026, 3, 3) },
            ],
          },
        };
      }
      return { body: { status: "OK", results: [{ ex_dividend_date: "2026-03-03", cash_amount: 1 }] } };
    });
    const result = await getDailyCloses("XPUB", "2026-03-02", "2026-03-03");
    expect(result).toEqual({
      success: true,
      data: [
        { date: "2026-03-02", close: 100, adjustedClose: 99 },
        { date: "2026-03-03", close: 99, adjustedClose: 99 },
      ],
    });
    const urls = fetchMock.mock.calls.map(([url]) => url);
    // From the start of the year through today, whatever day in it was asked for.
    expect(urls[0]).toContain(`/v2/aggs/ticker/XPUB/range/1/day/2026-01-01/${new Date().toISOString().slice(0, 10)}?adjusted=true`);
    expect(urls[1]).toContain("/v3/reference/dividends?ticker=XPUB&ex_dividend_date.gte=2026-01-01");
  });

  it("restates a dividend declared before a later split per today's share", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/v2/aggs/")) {
        return {
          body: {
            status: "OK",
            results: [
              { c: 10, t: polygonTs(2026, 3, 2) },
              { c: 9.9, t: polygonTs(2026, 3, 3) },
            ],
          },
        };
      }
      if (url.includes("/v3/reference/splits")) {
        return { body: { status: "OK", results: [{ execution_date: "2026-06-10", split_from: 1, split_to: 10 }] } };
      }
      return { body: { status: "OK", results: [{ ex_dividend_date: "2026-03-03", cash_amount: 1 }] } };
    });
    const result = await getDailyCloses("XPUB", "2026-03-02", "2026-03-03");
    expect(result.success && result.data[0].adjustedClose).toBeCloseTo(9.9, 10);
    expect(fetchMock.mock.calls.map(([url]) => url)[2]).toContain("/v3/reference/splits?ticker=XPUB&execution_date.gte=2026-01-01");
  });

  it("a refused splits call fails the fetch instead of using unadjusted dividends", async () => {
    mockFetch((url) => {
      if (url.includes("/v2/aggs/")) {
        const results = [
          { c: 10, t: polygonTs(2026, 3, 2) },
          { c: 9.9, t: polygonTs(2026, 3, 3) },
        ];
        return { body: { status: "OK", results } };
      }
      if (url.includes("/v3/reference/splits")) return { status: 429, body: { status: "ERROR", error: "rate limit" } };
      return { body: { status: "OK", results: [{ ex_dividend_date: "2026-03-03", cash_amount: 1 }] } };
    });
    const result = await getDailyCloses("XPUB", "2026-03-02", "2026-03-03");
    expect(result.success).toBe(false);
  });

  it("falls back to Yahoo's own adjusted series when Polygon has no bars", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("polygon.io")) return { body: { status: "OK", resultsCount: 0 } };
      return { body: yahooChart([yahooTs(2026, 3, 2), yahooTs(2026, 3, 3), yahooTs(2026, 3, 4)], [50, null, 52], [40, 41, 42]) };
    });
    const result = await getDailyCloses("XMUT", "2026-03-02", "2026-03-04");
    expect(result).toEqual({
      success: true,
      data: [
        { date: "2026-03-02", close: 50, adjustedClose: 40 },
        { date: "2026-03-04", close: 52, adjustedClose: 42 },
      ],
    });
    const yahooUrl = fetchMock.mock.calls.map(([url]) => url).find((u) => u.includes("yahoo"))!;
    expect(yahooUrl).toContain(`period1=${Date.UTC(2026, 0, 1) / 1000}`);
    // Through the end of today, the inclusive end of the fetched range.
    const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    expect(yahooUrl).toContain(`period2=${(today + 86_400_000) / 1000}`);
  });

  it("a Yahoo answer without adjusted closes is no data rather than a raw-close series", async () => {
    mockFetch((url) =>
      url.includes("polygon.io")
        ? { body: { status: "OK" } }
        : { body: yahooChart([yahooTs(2026, 3, 2)], [50]) },
    );
    const result = await getDailyCloses("XMUT", "2026-03-02", "2026-03-02");
    expect(result).toMatchObject({ success: false, error: "no_data" });
  });

  it("an unconfigured or refusing Polygon surfaces as-is instead of falling back", async () => {
    process.env.POLYGON_API_KEY = "";
    const fetchMock = mockFetch(() => ({ body: {} }));
    expect(await getDailyCloses("XPUB", "2026-03-02", "2026-03-02")).toMatchObject({ error: "no_api_key" });
    expect(fetchMock).not.toHaveBeenCalled();

    clearDailyClosesCache();
    process.env.POLYGON_API_KEY = "test-key";
    mockFetch(() => ({ status: 403, body: { status: "NOT_AUTHORIZED", message: "plan" } }));
    expect(await getDailyCloses("XPUB", "2026-03-02", "2026-03-02")).toMatchObject({ error: "plan_limit" });
  });

  it("serves any range inside the fetched window from memory, wherever in the year it starts", async () => {
    const fetchMock = mockFetch((url) =>
      url.includes("/v2/aggs/")
        ? {
            body: {
              status: "OK",
              results: [
                { c: 100, t: polygonTs(2026, 3, 2) },
                { c: 101, t: polygonTs(2026, 3, 9) },
              ],
            },
          }
        : { body: { status: "OK", results: [] } },
    );
    await getDailyCloses("XPUB", "2026-03-02", "2026-03-02");
    const later = await getDailyCloses("XPUB", "2026-03-05", "2026-03-09");
    expect(later.success && later.data.map((b) => b.date)).toEqual(["2026-03-09"]);
    // A day earlier, the shape a script would use to force a fresh fetch.
    await getDailyCloses("XPUB", "2026-03-01", "2026-03-09");
    await getDailyCloses("XPUB", "2026-01-01", "2026-03-09");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await getDailyCloses("XPUB", "2025-12-20", "2026-03-09");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("remembers a symbol with no data on either source for a while", async () => {
    const fetchMock = mockFetch((url) =>
      url.includes("polygon.io") ? { body: { status: "OK" } } : { body: { chart: { result: null, error: { code: "Not Found" } } } },
    );
    await getDailyCloses("XNONE", "2026-03-02", "2026-03-02");
    const calls = fetchMock.mock.calls.length;
    expect(peekDailyCloses("XNONE", "2026-03-05", "2026-03-05")).toMatchObject({ success: false, error: "no_data" });
    await getDailyCloses("XNONE", "2026-03-05", "2026-03-05");
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("a background warm-up is reported as loading, then serves from memory", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = mock(async (url: string) => {
      await gate;
      const body = url.includes("/v2/aggs/")
        ? { status: "OK", results: [{ c: 100, t: polygonTs(2026, 3, 2) }] }
        : { status: "OK", results: [] };
      return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    warmDailyCloses("XPUB", "2026-03-02");
    warmDailyCloses("XPUB", "2026-03-02");
    expect(peekDailyCloses("XPUB", "2026-03-02", "2026-03-02")).toBe("loading");
    expect(await getDailyCloses("XPUB", "2026-03-02", "2026-03-02")).toMatchObject({ error: "rate_limited" });

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(peekDailyCloses("XPUB", "2026-03-02", "2026-03-02")).toMatchObject({ success: true });
  });

  it("a busy gate isn't remembered as a failure, so the next ask can try again", async () => {
    mockFetch((url) => (url.includes("polygon.io") ? { body: { status: "OK" } } : { status: 429, body: {} }));
    expect(await getDailyCloses("XBUSY", "2026-03-02", "2026-03-02")).toMatchObject({ error: "rate_limited" });
    expect(peekDailyCloses("XBUSY", "2026-03-02", "2026-03-02")).toBeUndefined();
  });

  it("one wait budget covers every Polygon call", async () => {
    mockFetch((url) => ({
      body: url.includes("/v2/aggs/")
        ? { status: "OK", results: [{ c: 100, t: polygonTs(2026, 3, 2) }] }
        : url.includes("/v3/reference/dividends")
          ? { status: "OK", results: [{ ex_dividend_date: "2026-03-02", cash_amount: 1 }] }
          : { status: "OK", results: [] },
    }));
    const slowFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return slowFetch(url);
    }) as unknown as typeof fetch;
    const waits: (number | undefined)[] = [];
    const add = polygonQueue.add.bind(polygonQueue);
    const spy = spyOn(polygonQueue, "add").mockImplementation((task, options) => {
      waits.push(options?.maxWaitMs);
      return add(task, options);
    });
    try {
      await getDailyCloses("XPUB", "2026-03-02", "2026-03-02", { maxWaitMs: 1000 });
    } finally {
      spy.mockRestore();
    }
    // Each later call gets what's left after the ones before it, not a fresh budget.
    expect(waits[0]).toBeGreaterThan(990);
    expect(waits[1]).toBeLessThan(750);
    expect(waits[2]).toBeLessThan(450);
  });
});
