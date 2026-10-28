import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Products, PlaidErrorType } from "plaid";
import { getDateString } from "common";
import type { JSONItem } from "common";
import type { MaskedUser } from "server";
import { getInvestmentTransactions } from "./transactions";
import type { InvestmentTransactionDeps } from "./transactions";

// No mock.module calls in this file, on purpose. mock.module is
// process-global in Bun: a module imported while a mock is registered
// keeps the mock, so mocking the shared leaves this function needs
// (plaid util, items repo, logger) leaked into sibling test files and
// broke the suite whenever it ran together: webhook.test.ts's
// spyOn(logger, "warn") wrapped the shared mock logger and counted
// warnings from other tests (4 vs 1), items.test.ts bound the mocked
// upsertItems, and get-institutions tests bound the mocked plaid util.
// Instead the function takes its Plaid client and item writes as an
// injected `deps` argument (see transactions.ts): the fakes below are
// plain function mocks, visible only to these tests. The real logger
// stays in place — it is test-silent by default — and the real
// ignorable-error set is used, since it already holds exactly
// NO_INVESTMENT_ACCOUNTS.

const mockUpsertItems = mock(() => Promise.resolve());
const mockUpdateItemStatus = mock(() => Promise.resolve());

// The production caller always builds the request with options (see
// transactions.ts), so the fake only ever sees that shape — no `any` needed.
type InvestmentTransactionsGetRequestStub = {
  options: { offset: number };
};
type InvestmentTransactionsGetResponseStub = {
  data: {
    investment_transactions: { investment_transaction_id: string }[];
    total_investment_transactions: number;
  };
};

let investmentsTransactionsGetImpl: (
  request: InvestmentTransactionsGetRequestStub,
) => Promise<InvestmentTransactionsGetResponseStub> = async () => ({
  data: { investment_transactions: [], total_investment_transactions: 0 },
});
const mockGetClient = mock(() => ({
  investmentsTransactionsGet: (request: InvestmentTransactionsGetRequestStub) =>
    investmentsTransactionsGetImpl(request),
}));

// The injected deps for every test below. The client fake is cast: its
// stub response carries only the fields these tests use, not the full
// Plaid response shape.
const deps = {
  getClient: mockGetClient as unknown as InvestmentTransactionDeps["getClient"],
  upsertItems: mockUpsertItems,
  updateItemStatus: mockUpdateItemStatus,
};

// Call-history hygiene only: these are plain function mocks, so clearing
// them cannot touch any other file.
beforeEach(() => {
  mockUpsertItems.mockClear();
  mockUpdateItemStatus.mockClear();
});

const makeItem = (overrides: Partial<JSONItem> = {}): JSONTransactionItem =>
  ({
    item_id: "item-1",
    access_token: "test-access-token",
    updated: "2020-01-01",
    available_products: [Products.Investments],
    ...overrides,
  }) as unknown as JSONTransactionItem;

type JSONTransactionItem = JSONItem;

const makePage = (offset: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    investment_transaction_id: `inv-${offset + i}`,
  }));

const okResponse = (offset: number, count: number, total: number) => ({
  data: {
    investment_transactions: makePage(offset, count),
    total_investment_transactions: total,
  },
});

const plaidFailure = (code: string) => {
  const error = new Error(code) as Error & {
    response: { data: { error_code: string; error_type: string } };
  };
  error.response = {
    data: { error_code: code, error_type: PlaidErrorType.ApiError },
  };
  return error;
};

const user = {} as unknown as MaskedUser;

describe("getInvestmentTransactions", () => {
  it("pushes the item exactly once and advances the watermark on a clean multi-page run", async () => {
    investmentsTransactionsGetImpl = async (request: InvestmentTransactionsGetRequestStub) => {
      const offset = request.options.offset as number;
      const remaining = 250 - offset;
      const count = Math.min(100, remaining);
      return okResponse(offset, count, 250);
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item], deps);

    expect(data.items).toHaveLength(1);
    expect(data.investmentTransactions).toHaveLength(250);
    expect(data.items[0].updated).toBe(getDateString(new Date()));
    // The caller's object is not mutated in place.
    expect(item.updated).toBe("2020-01-01");
  });

  it("does not advance the watermark when a mid-pagination page fails", async () => {
    investmentsTransactionsGetImpl = async (request: InvestmentTransactionsGetRequestStub) => {
      const offset = request.options.offset as number;
      if (offset === 100) throw plaidFailure("INTERNAL_SERVER_ERROR");
      const remaining = 250 - offset;
      return okResponse(offset, Math.min(100, remaining), 250);
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item], deps);

    // Exactly one push, carrying the error — and the watermark stays put so
    // the next sync re-fetches the window instead of stranding the page.
    expect(data.items).toHaveLength(1);
    expect(data.items[0].plaidError?.error_code).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    expect(data.items[0].updated).toBe("2020-01-01");
    expect(item.updated).toBe("2020-01-01");
    // Only page 1's rows were fetched; the loop stopped at the failure.
    expect(data.investmentTransactions).toHaveLength(100);
  });

  it("does not advance the watermark when a mid-pagination page fails without a Plaid response payload", async () => {
    investmentsTransactionsGetImpl = async (request: InvestmentTransactionsGetRequestStub) => {
      const offset = request.options.offset as number;
      // A transport error: no response.data, so no plaidError is ever set.
      if (offset === 100) throw new Error("socket hangup");
      const remaining = 250 - offset;
      return okResponse(offset, Math.min(100, remaining), 250);
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item], deps);

    // One push, carrying no plaidError — and the watermark stays put, so
    // the next sync re-fetches the window. Gating on plaidError
    // nullability advanced the watermark here (succeeded was already true).
    expect(data.items).toHaveLength(1);
    expect(data.items[0].plaidError).toBeUndefined();
    expect(data.items[0].updated).toBe("2020-01-01");
    expect(item.updated).toBe("2020-01-01");
    expect(data.investmentTransactions).toHaveLength(100);
  });

  it("pushes the item (without a plaidError) when the first page fails without a Plaid response payload", async () => {
    investmentsTransactionsGetImpl = async () => {
      throw new Error("socket hangup");
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item], deps);

    // The old code pushed the item on a first-page failure; dropping it
    // silently loses the item from the sync result.
    expect(data.items).toHaveLength(1);
    expect(data.items[0].plaidError).toBeUndefined();
    expect(data.items[0].updated).toBe("2020-01-01");
    expect(data.investmentTransactions).toHaveLength(0);
  });

  it("pushes the item without advancing the watermark when PRODUCTS_NOT_SUPPORTED follows a successful page", async () => {
    investmentsTransactionsGetImpl = async (request: InvestmentTransactionsGetRequestStub) => {
      const offset = request.options.offset as number;
      if (offset === 100) throw plaidFailure("PRODUCTS_NOT_SUPPORTED");
      return okResponse(offset, 100, 250);
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item], deps);

    // The old code had already pushed the item for page 1 before the
    // failure; the rewrite dropped it. The watermark must not advance
    // past the failed page.
    expect(data.items).toHaveLength(1);
    expect(data.items[0].updated).toBe("2020-01-01");
    expect(item.updated).toBe("2020-01-01");
    expect(data.investmentTransactions).toHaveLength(100);
    expect(mockUpsertItems).toHaveBeenCalled();
  });

  it("pushes nothing and leaves the watermark alone on PRODUCTS_NOT_SUPPORTED", async () => {
    investmentsTransactionsGetImpl = async () => {
      throw plaidFailure("PRODUCTS_NOT_SUPPORTED");
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item], deps);

    expect(data.items).toHaveLength(0);
    expect(item.updated).toBe("2020-01-01");
    expect(mockUpsertItems).toHaveBeenCalled();
  });

  it("pushes nothing on ignorable errors and keeps looping", async () => {
    const seenOffsets: number[] = [];
    investmentsTransactionsGetImpl = async (request: InvestmentTransactionsGetRequestStub) => {
      seenOffsets.push(request.options.offset as number);
      throw plaidFailure("NO_INVESTMENT_ACCOUNTS");
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item], deps);

    expect(data.items).toHaveLength(0);
    expect(item.updated).toBe("2020-01-01");
    expect(seenOffsets.length).toBeGreaterThan(0);
  });
});
