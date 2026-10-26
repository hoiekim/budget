import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, clearSqlMocks } = createFakeSql();

mock.module("../sql-driver", () => driver);

const { updateInvestmentTransactions, createManualInvestmentTransaction } = await import(
  "./investment_transactions"
);

afterAll(restoreLeaves);

const mockUser = { user_id: "usr-1", username: "tester" } as {
  user_id: string;
  username: string;
};

const ID = "itx-1";

/**
 * The statement a write emitted, as the columns it set paired with the values
 * it bound. Asserting the columns alone passes on a statement that writes the
 * right column with the wrong number, which is most of what can go wrong here.
 */
const written = (verb: "UPDATE" | "INSERT"): Record<string, unknown> => {
  const call = mockUnsafe.mock.calls.find((c) => new RegExp(`^\\s*${verb}`, "i").test(String(c[0])));
  if (!call) return {};
  const sql = String(call[0]);
  const values = (call[1] as unknown[]) ?? [];

  // Bind by placeholder number rather than by position: both statements carry
  // columns that are not parameters (`updated = CURRENT_TIMESTAMP`), so a
  // positional zip reports every later column's value as its neighbour's.
  const bind = (expression: string): { bound: boolean; value?: unknown } => {
    const match = expression.match(/\$(\d+)/);
    return match ? { bound: true, value: values[Number(match[1]) - 1] } : { bound: false };
  };

  const pairs: [string, unknown][] = [];
  if (verb === "UPDATE") {
    const clause = sql.split(/\sSET\s/i)[1]?.split(/\sWHERE\s/i)[0] ?? "";
    for (const part of clause.split(/,\s*/)) {
      const [column, expression] = part.split(/\s*=\s*/);
      const { bound, value } = bind(expression ?? "");
      if (bound) pairs.push([column.trim(), value]);
    }
  } else {
    const columns = sql.match(/\(([^)]*)\)\s*VALUES/i)?.[1]?.split(/,\s*/) ?? [];
    const expressions = sql.split(/VALUES\s*\(/i)[1]?.split(/\)\s*(?:RETURNING|ON|$)/i)[0] ?? "";
    const parts = expressions.split(/,\s*/);
    columns.forEach((column, i) => {
      const { bound, value } = bind(parts[i] ?? "");
      if (bound) pairs.push([column.trim(), value]);
    });
  }
  return Object.fromEntries(pairs);
};

beforeEach(() => {
  clearSqlMocks();
  mockUnsafe.mockImplementation(async () => ({
    rows: [{ investment_transaction_id: ID, inv_unknown_index: 0 }],
    rowCount: 1,
  }));
});

// The mint stores the row it is asked for. Reconciling the four shape fields
// is the caller's job — it is the only party that knows which field the user
// touched — so the type arrives named rather than being worked out twice, once
// here and once for the caller's own optimistic copy.
describe("createManualInvestmentTransaction", () => {
  test("the caller's type is stored, so a sale is not minted as a purchase", async () => {
    await createManualInvestmentTransaction(mockUser, {
      account_id: "acc-1",
      quantity: -5,
      price: 30,
      type: InvestmentTransactionType.Sell,
    });

    const row = written("INSERT");
    expect(row.type).toBe(InvestmentTransactionType.Sell);
    expect(row.subtype).toBe(InvestmentTransactionSubtype.Sell);
    expect(Number(row.quantity)).toBe(-5);
    expect(Number(row.amount)).toBeCloseTo(-150, 2);
  });

  test("a purchase is stored as one", async () => {
    await createManualInvestmentTransaction(mockUser, {
      account_id: "acc-1",
      quantity: 4,
      price: 25,
      type: InvestmentTransactionType.Buy,
    });

    const row = written("INSERT");
    expect(row.type).toBe(InvestmentTransactionType.Buy);
    expect(Number(row.quantity)).toBe(4);
    expect(Number(row.amount)).toBeCloseTo(100, 2);
  });

  // The account-level mint names no type, and a row has to start somewhere.
  test("a caller naming no type gets a purchase", async () => {
    await createManualInvestmentTransaction(mockUser, {
      account_id: "acc-1",
      quantity: 2,
      price: 30,
    });

    const row = written("INSERT");
    expect(row.type).toBe(InvestmentTransactionType.Buy);
    expect(Number(row.amount)).toBeCloseTo(60, 2);
  });
});

// `source` records which writer produced a row, nothing resets it, and
// normalization is scoped by it — so a patch able to set it would let a
// provider row be relabelled permanently and rewritten from then on.
describe("updateInvestmentTransactions — provenance", () => {
  test("a patch naming source does not write it", async () => {
    await updateInvestmentTransactions(mockUser, [
      { investment_transaction_id: ID, source: "manual", quantity: 3 } as never,
    ]);

    const row = written("UPDATE");
    expect(row).not.toHaveProperty("source");
    expect(Number(row.quantity)).toBe(3);
  });

  test("a patch naming only source writes nothing in its place", async () => {
    await updateInvestmentTransactions(mockUser, [
      { investment_transaction_id: ID, source: "manual" } as never,
    ]);

    expect(written("UPDATE")).not.toHaveProperty("source");
  });

  // Reconciling the four shape fields is the editor's job, because only it
  // knows which one the user just touched. What arrives is stored as sent.
  test("the fields a patch does name are written with the values it sent", async () => {
    await updateInvestmentTransactions(mockUser, [
      {
        investment_transaction_id: ID,
        type: InvestmentTransactionType.Sell,
        quantity: -5,
        amount: -150,
      },
    ]);

    const row = written("UPDATE");
    expect(row.type).toBe(InvestmentTransactionType.Sell);
    expect(Number(row.quantity)).toBe(-5);
    expect(Number(row.amount)).toBeCloseTo(-150, 2);
  });

  test("a patch touching none of the shape fields leaves every one of them alone", async () => {
    await updateInvestmentTransactions(mockUser, [
      { investment_transaction_id: ID, label: { memo: "note" } },
    ]);

    const row = written("UPDATE");
    expect(row).not.toHaveProperty("price");
    expect(row).not.toHaveProperty("amount");
    expect(row).not.toHaveProperty("quantity");
    expect(row).not.toHaveProperty("subtype");
    expect(row).not.toHaveProperty("type");
  });
});
