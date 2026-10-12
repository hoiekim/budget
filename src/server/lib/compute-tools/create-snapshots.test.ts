import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";
import { getSquashedDateString, type JSONSecurity } from "common";

const { pg, mockQuery, clearQueryMocks } = createFakePg();

mock.module("pg", () => pg);

const { upsertSecuritiesWithSnapshots } = await import("./create-snapshots");

afterAll(restoreLeaves);

beforeEach(() => {
  clearQueryMocks();
});

const mkSecurity = (overrides: Partial<JSONSecurity>): JSONSecurity =>
  ({
    security_id: "sec-a",
    name: "Test Security",
    ticker_symbol: "TICK",
    type: "equity",
    close_price: 100,
    close_price_as_of: "2026-07-06",
    iso_currency_code: "USD",
    isin: null,
    cusip: null,
    ...overrides,
  }) as JSONSecurity;

describe("upsertSecuritiesWithSnapshots — identity-not-ticker semantics", () => {
  test("two securities with the same ticker but different security_ids BOTH survive", async () => {
    const result = await upsertSecuritiesWithSnapshots([
      mkSecurity({ security_id: "manual-voo", ticker_symbol: "VOO" }),
      mkSecurity({ security_id: "plaid-voo", ticker_symbol: "VOO" }),
    ]);
    expect(result.has("manual-voo")).toBe(true);
    expect(result.has("plaid-voo")).toBe(true);
    expect(result.size).toBe(2);
    // No `SELECT ... FROM securities WHERE ticker_symbol` — the caller
    // must not look up an existing row and rewrite the incoming id.
    const searchCalls = mockQuery.mock.calls.filter(([sql]) =>
      /SELECT[\s\S]*FROM securities[\s\S]*ticker_symbol/i.test(sql as string),
    );
    expect(searchCalls.length).toBe(0);
  });

  test("skips securities without a ticker_symbol", async () => {
    const result = await upsertSecuritiesWithSnapshots([
      mkSecurity({ security_id: "no-ticker", ticker_symbol: null }),
      mkSecurity({ security_id: "with-ticker", ticker_symbol: "AAPL" }),
    ]);
    expect(result.has("no-ticker")).toBe(false);
    expect(result.has("with-ticker")).toBe(true);
    expect(result.size).toBe(1);
  });

  test("skips securities without a close_price or close_price_as_of", async () => {
    const result = await upsertSecuritiesWithSnapshots([
      mkSecurity({ security_id: "no-price", close_price: null }),
      mkSecurity({ security_id: "no-date", close_price_as_of: null }),
      mkSecurity({ security_id: "ok" }),
    ]);
    expect(result.has("no-price")).toBe(false);
    expect(result.has("no-date")).toBe(false);
    expect(result.has("ok")).toBe(true);
    expect(result.size).toBe(1);
  });

  test("returns empty set when nothing to upsert", async () => {
    const result = await upsertSecuritiesWithSnapshots([]);
    expect(result.size).toBe(0);
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  test("returns the same security_id the caller passed in — never rewrites onto an existing row's id", async () => {
    // Pre-queue what a hypothetical `searchSecurities` would return if the
    // function still ticker-searched — the collision-branch behavior would
    // rewrite the incoming id onto whatever this row's id is. The test
    // asserts we see the INCOMING id back, not this stale id.
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ security_id: "existing-old-id", ticker_symbol: "VOO", close_price_as_of: "2020-01-01" }],
      rowCount: 1,
    }));
    const result = await upsertSecuritiesWithSnapshots([
      mkSecurity({ security_id: "brand-new-id", ticker_symbol: "VOO" }),
    ]);
    expect(result.has("brand-new-id")).toBe(true);
    expect(result.has("existing-old-id")).toBe(false);
  });
});

describe("upsertSecuritiesWithSnapshots — price snapshot date", () => {
  const snapshotParams = () =>
    mockQuery.mock.calls
      .filter(([sql]) => /INSERT INTO snapshots/i.test(sql as string))
      .flatMap(([, params]) => (params ?? []) as unknown[]);
  const today = getSquashedDateString();

  test("closePriceAsOf keys the snapshot on the trading day the close is for", async () => {
    await upsertSecuritiesWithSnapshots(
      [mkSecurity({ security_id: "sec-a", close_price_as_of: "2026-07-06" })],
      "closePriceAsOf",
    );
    const params = snapshotParams();
    expect(params).toContain("sec-a-20260706");
    expect(params).toContain("2026-07-06T12:00:00.000Z");
  });

  test("closePriceAsOf reads the calendar date as written, whatever time and offset follow it", async () => {
    await upsertSecuritiesWithSnapshots(
      [mkSecurity({ security_id: "sec-b", close_price_as_of: "2026-07-02T23:00:00-07:00" })],
      "closePriceAsOf",
    );
    expect(snapshotParams()).toContain("sec-b-20260702");
  });

  test("closePriceAsOf skips a security whose close_price_as_of is not a date", async () => {
    const result = await upsertSecuritiesWithSnapshots(
      [mkSecurity({ security_id: "bad-date", close_price_as_of: "yesterday" }), mkSecurity({ security_id: "ok" })],
      "closePriceAsOf",
    );
    expect(result.has("bad-date")).toBe(false);
    expect(result.has("ok")).toBe(true);
  });

  test("crypto stays on the sync date: it trades around the clock, so its price is current", async () => {
    await upsertSecuritiesWithSnapshots(
      [mkSecurity({ security_id: "btc", type: "cryptocurrency", close_price_as_of: "2026-06-01" })],
      "closePriceAsOf",
    );
    const params = snapshotParams();
    expect(params).toContain(`btc-${today}`);
    expect(params).not.toContain("btc-20260601");
  });

  test("syncTime, the default, files the price under the sync date, not close_price_as_of", async () => {
    // SimpleFIN's close_price_as_of is the holding's creation time, not a price date.
    await upsertSecuritiesWithSnapshots([mkSecurity({ security_id: "sfin", close_price_as_of: "2024-01-01" })]);
    const params = snapshotParams();
    expect(params).toContain(`sfin-${today}`);
    expect(params).not.toContain("sfin-20240101");
  });
});
