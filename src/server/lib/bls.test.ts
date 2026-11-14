// `bls.ts` reads `BLS_API_KEY` on every call, so each test sets the tier it
// wants. `globalThis.fetch` is replaced for the file and put back by
// `restoreLeaves`; the env var is restored from the snapshot below.
const originalApiKey = process.env.BLS_API_KEY;
delete process.env.BLS_API_KEY;

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const okBody = (data: Array<{ year: string; period: string; value: string }>) => ({
  status: "REQUEST_SUCCEEDED",
  message: [],
  Results: { series: [{ seriesID: "CUUR0000SA0", data }] },
});

const mockFetch = mock(
  async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    new Response(JSON.stringify(okBody([{ year: "2026", period: "M01", value: "320.5" }]))),
);
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const {
  getCpiSeries,
  getBlsTier,
  parseCpiObservations,
  resetBlsRequestBudget,
  CPI_SERIES_ID,
} = await import("./bls");

afterAll(() => {
  if (originalApiKey === undefined) delete process.env.BLS_API_KEY;
  else process.env.BLS_API_KEY = originalApiKey;
  restoreLeaves();
});

const respondWith = (body: unknown, status = 200) => {
  mockFetch.mockImplementationOnce(async () => new Response(JSON.stringify(body), { status }));
};

const lastRequest = () => {
  const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return { url: String(url), body: JSON.parse(String(init?.body)) };
};

beforeEach(() => {
  delete process.env.BLS_API_KEY;
  resetBlsRequestBudget();
  mockFetch.mockClear();
});

describe("getBlsTier", () => {
  test("keyless deployments use v1 and spend well under its 25/day cap", () => {
    const tier = getBlsTier();
    expect(tier.version).toBe("v1");
    expect(tier.maxYearsPerRequest).toBe(10);
    expect(tier.dailyBudget).toBeLessThanOrEqual(tier.dailyLimit / 2);
  });

  test("a registration key moves to v2 and stays well under its 500/day cap", () => {
    process.env.BLS_API_KEY = "key";
    const tier = getBlsTier();
    expect(tier.version).toBe("v2");
    expect(tier.maxYearsPerRequest).toBe(20);
    expect(tier.dailyBudget).toBeLessThanOrEqual(tier.dailyLimit / 2);
  });
});

describe("parseCpiObservations", () => {
  test("keeps monthly periods, drops the annual average and unpublished months", () => {
    const parsed = parseCpiObservations(
      okBody([
        { year: "2025", period: "M13", value: "322.0" },
        { year: "2025", period: "M11", value: "324.1" },
        // BLS publishes October 2025 as "-" (not collected during the shutdown).
        { year: "2025", period: "M10", value: "-" },
        { year: "2025", period: "M09", value: "324.8" },
        { year: "2025", period: "S01", value: "321.0" },
      ]),
    );
    expect(parsed).toEqual([
      { year: 2025, month: 9, value: 324.8 },
      { year: 2025, month: 11, value: 324.1 },
    ]);
  });

  test("tolerates a body with no series", () => {
    expect(parseCpiObservations({ status: "REQUEST_SUCCEEDED" })).toEqual([]);
  });
});

describe("getCpiSeries", () => {
  test("posts the series and year span to the keyless v1 endpoint", async () => {
    const result = await getCpiSeries(2016, 2025);
    expect(result).toEqual({ success: true, data: [{ year: 2026, month: 1, value: 320.5 }] });

    const { url, body } = lastRequest();
    expect(url).toBe("https://api.bls.gov/publicAPI/v1/timeseries/data/");
    expect(body).toEqual({ seriesid: [CPI_SERIES_ID], startyear: "2016", endyear: "2025" });
  });

  test("sends the registration key to the v2 endpoint when one is configured", async () => {
    process.env.BLS_API_KEY = "secret";
    await getCpiSeries(2006, 2025);
    const { url, body } = lastRequest();
    expect(url).toBe("https://api.bls.gov/publicAPI/v2/timeseries/data/");
    expect(body.registrationkey).toBe("secret");
  });

  test("refuses a span wider than the tier allows without spending a request", async () => {
    const result = await getCpiSeries(2006, 2025);
    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("reports BLS's daily-threshold refusal as rate_limited", async () => {
    respondWith({
      status: "REQUEST_NOT_PROCESSED",
      message: ["The daily threshold for total number of requests allocated to the user has been reached."],
    });
    const result = await getCpiSeries(2025, 2026);
    expect(result).toMatchObject({ success: false, error: "rate_limited" });
  });

  test("reports any other refusal as api_error with BLS's message", async () => {
    respondWith({ status: "REQUEST_FAILED_INVALID_PARAMETERS", message: ["Invalid Series"] });
    const result = await getCpiSeries(2025, 2026);
    expect(result).toEqual({ success: false, error: "api_error", message: "Invalid Series" });
  });

  test("reports a non-2xx response as api_error", async () => {
    respondWith({}, 503);
    const result = await getCpiSeries(2025, 2026);
    expect(result).toMatchObject({ success: false, error: "api_error", message: "BLS HTTP 503" });
  });

  test("reports a network failure as api_error", async () => {
    mockFetch.mockImplementationOnce(async () => {
      throw new Error("socket hang up");
    });
    const result = await getCpiSeries(2025, 2026);
    expect(result).toMatchObject({ success: false, error: "api_error", message: "socket hang up" });
  });

  test("reports a successful answer with no usable months as no_data", async () => {
    respondWith(okBody([{ year: "2025", period: "M10", value: "-" }]));
    const result = await getCpiSeries(2025, 2025);
    expect(result).toMatchObject({ success: false, error: "no_data" });
  });

  test("stops at the daily budget instead of waiting for a slot", async () => {
    const { dailyBudget } = getBlsTier();
    for (let i = 0; i < dailyBudget; i++) {
      expect((await getCpiSeries(2025, 2026)).success).toBe(true);
    }
    const started = Date.now();
    const over = await getCpiSeries(2025, 2026);
    expect(over).toMatchObject({ success: false, error: "budget_exhausted" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(mockFetch).toHaveBeenCalledTimes(dailyBudget);
  });

  test("a failed request still counts against the budget", async () => {
    const { dailyBudget } = getBlsTier();
    mockFetch.mockImplementation(async () => new Response("{}", { status: 500 }));
    for (let i = 0; i < dailyBudget; i++) await getCpiSeries(2025, 2026);
    const over = await getCpiSeries(2025, 2026);
    expect(over).toMatchObject({ success: false, error: "budget_exhausted" });
    mockFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify(okBody([{ year: "2026", period: "M01", value: "320.5" }]))),
    );
  });
});
