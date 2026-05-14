/**
 * Tests for POST /api/account — focused on the new "block balances.current
 * edit when holdings exist" guard added 2026-05-13.
 *
 * Mocking strategy mirrors `post-suggest-category.test.ts`: monkey-patch the
 * small surface we exercise (`holdingsTable.query` for the holdings probe
 * and `accountsTable.update` for the upsert path), restore in afterAll.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

import { accountsTable, holdingsTable } from "server";
import { postAccountRoute } from "./post-account";

const originalHoldingsQuery = holdingsTable.query.bind(holdingsTable);
const originalAccountsUpdate = accountsTable.update.bind(accountsTable);

// holdingsTable.query returns model instances whose .toJSON() yields a
// JSONHolding. The route only cares about `.length`, so any object with a
// stub .toJSON() works.
const makeHoldingModel = (row: Record<string, unknown>) => ({ toJSON: () => row });
const mockHoldingsQuery = mock(
  async (_filters: unknown): Promise<Array<{ toJSON: () => unknown }>> => [],
);
const mockAccountsUpdate = mock(async (_id: unknown, _data: unknown) => ({ account_id: "acc-1" }));

(holdingsTable as unknown as { query: typeof mockHoldingsQuery }).query = mockHoldingsQuery;
(accountsTable as unknown as { update: typeof mockAccountsUpdate }).update = mockAccountsUpdate;

afterAll(() => {
  (holdingsTable as unknown as { query: typeof originalHoldingsQuery }).query = originalHoldingsQuery;
  (accountsTable as unknown as { update: typeof originalAccountsUpdate }).update = originalAccountsUpdate;
});

beforeEach(() => {
  mockHoldingsQuery.mockReset();
  mockAccountsUpdate.mockReset();
  mockHoldingsQuery.mockImplementation(async () => []);
  mockAccountsUpdate.mockImplementation(async () => ({ account_id: "acc-1" }));
});

function makeReq(body: unknown, userId = "u-1") {
  return {
    method: "POST",
    path: "/account",
    url: "http://x/api/account",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: { user_id: userId, username: "test" },
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postAccountRoute.execute>[0];
}

const fakeRes = () =>
  ({
    statusCode: 200,
    headersSent: false,
    status() {
      return this;
    },
    write() {
      return true;
    },
    end() {},
  }) as unknown as Parameters<typeof postAccountRoute.execute>[1];

describe("post-account: holdings-aware balance edit guard", () => {
  test("rejects balances.current edit when the account has any holding", async () => {
    mockHoldingsQuery.mockImplementationOnce(async () => [
      makeHoldingModel({ holding_id: "h-1", account_id: "acc-1", security_id: "sec-1" }),
    ]);

    const result = await postAccountRoute.execute(
      makeReq({ account_id: "acc-1", balances: { current: 1000 } }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/holdings exist/i);
    expect(mockAccountsUpdate).toHaveBeenCalledTimes(0);
  });

  test("allows balances.current edit when the account has no holdings", async () => {
    mockHoldingsQuery.mockImplementationOnce(async () => []);
    mockAccountsUpdate.mockImplementationOnce(async () => ({ account_id: "acc-2" }));

    const result = await postAccountRoute.execute(
      makeReq({ account_id: "acc-2", balances: { current: 500 } }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(mockAccountsUpdate).toHaveBeenCalledTimes(1);
  });

  test("allows non-balance edits (e.g. rename) even when holdings exist", async () => {
    mockHoldingsQuery.mockImplementationOnce(async () => [
      { holding_id: "h-1", account_id: "acc-3", security_id: "sec-1" },
    ]);
    mockAccountsUpdate.mockImplementationOnce(async () => ({ account_id: "acc-3" }));

    const result = await postAccountRoute.execute(
      makeReq({ account_id: "acc-3", custom_name: "Renamed" }),
      fakeRes(),
    );

    // No `balances` in the body → the guard's branch never fires.
    expect(result?.status).toBe("success");
    expect(mockAccountsUpdate).toHaveBeenCalledTimes(1);
    // We also expect the holdings probe to be skipped because the body has
    // no `balances.current` to validate.
    expect(mockHoldingsQuery).toHaveBeenCalledTimes(0);
  });

  test("does not probe holdings when balances is present but lacks `current`", async () => {
    mockHoldingsQuery.mockImplementationOnce(async () => [
      { holding_id: "h-1", account_id: "acc-4", security_id: "sec-1" },
    ]);
    mockAccountsUpdate.mockImplementationOnce(async () => ({ account_id: "acc-4" }));

    // E.g. caller updating only `iso_currency_code` inside balances.
    const result = await postAccountRoute.execute(
      makeReq({ account_id: "acc-4", balances: { iso_currency_code: "USD" } }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(mockHoldingsQuery).toHaveBeenCalledTimes(0);
  });
});
