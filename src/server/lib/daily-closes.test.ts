import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { restoreFetch, restoreEnv } from "test-helpers";
import { adjustForDividends, clearDailyClosesCache, getDailyCloses } from "./daily-closes";
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
    // Fetched through today, so a later statement inside the range needs no call.
    expect(urls[0]).toContain(`/v2/aggs/ticker/XPUB/range/1/day/2026-03-02/${new Date().toISOString().slice(0, 10)}?adjusted=true`);
    expect(urls[1]).toContain("/v3/reference/dividends?ticker=XPUB&ex_dividend_date.gte=2026-03-02");
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
    expect(yahooUrl).toContain(`period1=${Date.UTC(2026, 2, 2) / 1000}`);
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

    process.env.POLYGON_API_KEY = "test-key";
    mockFetch(() => ({ status: 403, body: { status: "NOT_AUTHORIZED", message: "plan" } }));
    expect(await getDailyCloses("XPUB", "2026-03-02", "2026-03-02")).toMatchObject({ error: "plan_limit" });
  });

  it("serves any range inside one already fetched from memory, and refetches for an earlier start", async () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(later.success && later.data.map((b) => b.date)).toEqual(["2026-03-09"]);

    await getDailyCloses("XPUB", "2026-02-01", "2026-03-09");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
