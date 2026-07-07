import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import type { JSONSecurity } from "common";

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [] as unknown[],
  rowCount: 0 as number | null,
}));

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
}

mock.module("pg", () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {} },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
}));

const { upsertSecuritiesWithSnapshots } = await import("./create-snapshots");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockClear();
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

describe("upsertSecuritiesWithSnapshots — identity-not-ticker semantics (#593 gap 2 fix)", () => {
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
