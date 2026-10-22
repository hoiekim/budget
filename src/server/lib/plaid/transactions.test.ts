import { describe, it, expect, mock, afterEach } from "bun:test";
import { Products, PlaidErrorType } from "plaid";
import { getDateString } from "common";
import type { JSONItem } from "common";
import type { MaskedUser } from "server";

// mock.module is process-global in Bun, so mocks are restored after each
// test to keep sibling test files on the real exports.
//
// Ordering wrinkle: the "server" barrel re-exports ./plaid, so importing the
// barrel (or ./util, which imports the barrel) loads the module under test
// transitively — before any mock is registered — and the binding sticks.
// The mocks below therefore target the LEAF modules (registered before
// anything touches the barrel), and the module under test is imported
// dynamically only after all mocks are in place.
const realLoggerMod = await import("server/lib/logger");
const realItemsRepo = await import("server/lib/postgres/repositories/items");
// The real ./util can't be captured up front (it imports the barrel, which
// would load the module under test before the mocks are registered), so its
// factory hardcodes the one-line ignorable set — the only other export this
// module reads. If util.ts grows exports this module needs, update the
// factory. The restore copy is captured after registration via a
// cache-busting specifier.

const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};
const mockUpsertItems = mock(() => Promise.resolve());
const mockUpdateItemStatus = mock(() => Promise.resolve());

mock.module("server/lib/logger", () => ({
  ...realLoggerMod,
  logger: mockLogger,
}));
mock.module("server/lib/postgres/repositories/items", () => ({
  ...realItemsRepo,
  upsertItems: mockUpsertItems,
  updateItemStatus: mockUpdateItemStatus,
}));

let investmentsTransactionsGetImpl: (request: any) => Promise<any> =
  async () => ({
    data: { investment_transactions: [], total_investment_transactions: 0 },
  });
const mockGetClient = mock(() => ({
  investmentsTransactionsGet: (request: any) =>
    investmentsTransactionsGetImpl(request),
}));

mock.module("./util", () => ({
  getClient: mockGetClient,
  getProductionClient: mockGetClient,
  isPlaidConfigured: true,
  ignorable_error_codes: new Set(["NO_INVESTMENT_ACCOUNTS"]),
}));

// Captured after registration: the busted specifier gives a fresh real
// instance whose own exports are unaffected by the registered mocks.
const realUtilForRestore = await import("./util?restore-real");

afterEach(() => {
  mock.module("server/lib/logger", () => realLoggerMod);
  mock.module("server/lib/postgres/repositories/items", () => realItemsRepo);
  mock.module("./util", () => realUtilForRestore);
  mockUpsertItems.mockClear();
  mockUpdateItemStatus.mockClear();
});

// First plain barrel touch happens here (via the busted util's own "server"
// import above): binds the mocked leaves + mocked ./util.
const { getInvestmentTransactions } = await import("./transactions");

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
    investmentsTransactionsGetImpl = async (request: any) => {
      const offset = request.options.offset as number;
      const remaining = 250 - offset;
      const count = Math.min(100, remaining);
      return okResponse(offset, count, 250);
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item]);

    expect(data.items).toHaveLength(1);
    expect(data.investmentTransactions).toHaveLength(250);
    expect(data.items[0].updated).toBe(getDateString(new Date()));
    // The caller's object is not mutated in place.
    expect(item.updated).toBe("2020-01-01");
  });

  it("does not advance the watermark when a mid-pagination page fails", async () => {
    investmentsTransactionsGetImpl = async (request: any) => {
      const offset = request.options.offset as number;
      if (offset === 100) throw plaidFailure("INTERNAL_SERVER_ERROR");
      const remaining = 250 - offset;
      return okResponse(offset, Math.min(100, remaining), 250);
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item]);

    // Exactly one push, carrying the error — and the watermark stays put so
    // the next sync re-fetches the window instead of stranding the page.
    expect(data.items).toHaveLength(1);
    expect((data.items[0] as any).plaidError?.error_code).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    expect(data.items[0].updated).toBe("2020-01-01");
    expect(item.updated).toBe("2020-01-01");
    // Only page 1's rows were fetched; the loop stopped at the failure.
    expect(data.investmentTransactions).toHaveLength(100);
  });

  it("pushes nothing and leaves the watermark alone on PRODUCTS_NOT_SUPPORTED", async () => {
    investmentsTransactionsGetImpl = async () => {
      throw plaidFailure("PRODUCTS_NOT_SUPPORTED");
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item]);

    expect(data.items).toHaveLength(0);
    expect(item.updated).toBe("2020-01-01");
    expect(mockUpsertItems).toHaveBeenCalled();
  });

  it("pushes nothing on ignorable errors and keeps looping", async () => {
    const seenOffsets: number[] = [];
    investmentsTransactionsGetImpl = async (request: any) => {
      seenOffsets.push(request.options.offset as number);
      throw plaidFailure("NO_INVESTMENT_ACCOUNTS");
    };
    const item = makeItem();

    const data = await getInvestmentTransactions(user, [item]);

    expect(data.items).toHaveLength(0);
    expect(item.updated).toBe("2020-01-01");
    expect(seenOffsets.length).toBeGreaterThan(0);
  });
});
