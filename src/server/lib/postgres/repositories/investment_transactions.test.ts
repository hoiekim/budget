import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import { createFakePg, restoreLeaves } from "test-helpers";

const { pg, mockQuery, clearQueryMocks } = createFakePg();

mock.module("pg", () => pg);

const { updateInvestmentTransactions } = await import("./investment_transactions");

afterAll(restoreLeaves);

const mockUser = { user_id: "usr-1", username: "tester" } as {
  user_id: string;
  username: string;
};

const ID = "itx-1";

interface StoredRow {
  source: string;
  type: InvestmentTransactionType;
  subtype: InvestmentTransactionSubtype;
  quantity: number;
  price: number;
  amount: number;
}

/**
 * Answer the batched read with one stored row, and every later statement with
 * a generic success, so the statements the update itself issues can be read
 * back off `mockQuery`.
 */
const givenStored = (row: StoredRow) => {
  let served = false;
  mockQuery.mockImplementation(async (sql: string) => {
    if (!served && /select/i.test(sql)) {
      served = true;
      return {
        rows: [
          {
            investment_transaction_id: ID,
            user_id: mockUser.user_id,
            account_id: "acc-1",
            security_id: "sec-1",
            date: "2022-01-10",
            name: "Manual",
            iso_currency_code: "USD",
            label_budget_id: null,
            label_category_id: null,
            label_memo: null,
            raw: null,
            updated: "2022-01-10T00:00:00.000Z",
            is_deleted: false,
            ...row,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [{ investment_transaction_id: ID }], rowCount: 1 };
  });
};

/**
 * Columns a plain `UPDATE ... SET` assigns. `updateColumnsOf` in the shared
 * helpers parses an upsert's `DO UPDATE SET` and returns nothing for this
 * shape, which would make every assertion below vacuously true.
 */
const writtenColumns = (): string[] => {
  const sql = mockQuery.mock.calls
    .map((c) => c[0] as string)
    .find((s) => /^\s*UPDATE\s/i.test(s));
  const clause = sql?.split(/\sSET\s/i)[1]?.split(/\sWHERE\s/i)[0];
  if (!clause) return [];
  return clause
    .split(/,\s*/)
    .map((part) => part.trim().split(/\s*=/)[0].trim())
    .filter(Boolean);
};

const manual = (o: Partial<StoredRow> = {}): StoredRow => ({
  source: "manual",
  type: InvestmentTransactionType.Buy,
  subtype: InvestmentTransactionSubtype.Buy,
  quantity: 10,
  price: 10,
  amount: 100,
  ...o,
});

beforeEach(() => {
  clearQueryMocks();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
});

describe("updateInvestmentTransactions — normalizing a hand-entered row", () => {
  // The editor persists one field group at a time, so the canonical form is a
  // property of the merged row and cannot be decided from the patch alone.
  test("the stored row is read once for the whole batch, not once per transaction", async () => {
    givenStored(manual());

    await updateInvestmentTransactions(mockUser, [
      { investment_transaction_id: ID, quantity: -5, amount: -50 },
      { investment_transaction_id: "itx-2", quantity: -5, amount: -50 },
    ]);

    const selects = mockQuery.mock.calls.filter((c) => /select/i.test(c[0] as string));
    expect(selects).toHaveLength(1);
  });

  test("a negative quantity is stored as a sale, whatever type the row carried", async () => {
    givenStored(manual({ type: InvestmentTransactionType.Buy }));

    await updateInvestmentTransactions(mockUser, [
      { investment_transaction_id: ID, quantity: -5, amount: -150 },
    ]);

    const columns = writtenColumns();
    expect(columns).toContain("type");
    expect(columns).toContain("quantity");
  });

  // Flipping only the type would leave a sale carrying a positive quantity,
  // which is a differently inconsistent row rather than a consistent one.
  test("choosing Sell corrects the quantity left over from before", async () => {
    givenStored(manual({ quantity: 5, price: 30, amount: 150 }));

    await updateInvestmentTransactions(mockUser, [
      { investment_transaction_id: ID, type: InvestmentTransactionType.Sell },
    ]);

    const columns = writtenColumns();
    expect(columns).toContain("quantity");
    expect(columns).toContain("amount");
  });

  // One provider mints every movement as a `buy` of one unit priced at the
  // whole amount, signed positive when money arrives. Rewriting those would
  // turn its withdrawals into deposits.
  test("a provider row is written exactly as the patch asked", async () => {
    givenStored(manual({ source: "simple_fin", quantity: 1, price: -500, amount: -500 }));

    await updateInvestmentTransactions(mockUser, [
      { investment_transaction_id: ID, quantity: 1, amount: -500 },
    ]);

    const columns = writtenColumns();
    expect(columns).not.toContain("type");
    expect(columns).not.toContain("price");
  });

  // A row that moves no shares carries its value somewhere `price * quantity`
  // cannot express, so there is nothing here to make consistent.
  test("a manual row that moves no shares is written exactly as the patch asked", async () => {
    givenStored(manual({ type: InvestmentTransactionType.Cash, quantity: 0, price: 0, amount: 500 }));

    await updateInvestmentTransactions(mockUser, [
      { investment_transaction_id: ID, amount: 500 },
    ]);

    expect(writtenColumns()).not.toContain("type");
  });

  // Rewriting a column nobody touched with a value read a moment earlier
  // turns a concurrent edit of that column into a lost update.
  test("a column the patch leaves alone and normalization agrees with is not written", async () => {
    givenStored(manual({ quantity: 10, price: 10, amount: 100 }));

    await updateInvestmentTransactions(mockUser, [
      { investment_transaction_id: ID, price: 12, amount: 120 },
    ]);

    const columns = writtenColumns();
    expect(columns).toContain("price");
    expect(columns).not.toContain("quantity");
    expect(columns).not.toContain("type");
  });
});
