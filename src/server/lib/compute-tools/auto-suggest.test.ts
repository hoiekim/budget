import { describe, it, expect, mock } from "bun:test";
import { runAutoSuggestions } from "./auto-suggest";

// Dependency-injection style: pass mock queryFn + logger + fetchUsers directly to
// runAutoSuggestions. This avoids module mocking which can break other test files.

const noopLogger = {
  info: () => {},
  error: mock(() => {}),
};

describe("runAutoSuggestions", () => {
  it("skips when no users found", async () => {
    const queryFn = mock(async () => ({ rows: [] }));
    const fetchUsers = mock(async () => []);
    await runAutoSuggestions(queryFn, noopLogger, fetchUsers);
    expect(fetchUsers).toHaveBeenCalledTimes(1);
    // No queries beyond fetchUsers should fire when there are no users
    expect(queryFn).toHaveBeenCalledTimes(0);
  });

  it("skips transaction when total_labeled < 3", async () => {
    let updateCalled = false;
    const queryFn = mock(async (sql: string) => {
      if (sql.includes("label_category_confidence IS NULL")) {
        return { rows: [{ transaction_id: "txn-1", merchant_name: "Coffee Shop" }] };
      }
      if (sql.includes("SUM(CASE WHEN")) {
        // Only 2 labeled — below threshold of 3
        return { rows: [{ label_category_id: "cat-1", accepted: "2", rejected: "0" }] };
      }
      if (sql.includes("UPDATE transactions")) {
        updateCalled = true;
      }
      return { rows: [] };
    });
    const fetchUsers = async () => ["user-1"];

    await runAutoSuggestions(queryFn, noopLogger, fetchUsers);
    expect(updateCalled).toBe(false);
  });

  it("skips when reject_rate > 0.1", async () => {
    let updateCalled = false;
    const queryFn = mock(async (sql: string) => {
      if (sql.includes("label_category_confidence IS NULL")) {
        return { rows: [{ transaction_id: "txn-2", merchant_name: "Restaurant" }] };
      }
      if (sql.includes("SUM(CASE WHEN")) {
        // 8 accepted, 2 rejected → reject_rate = 0.2 > 0.1 → skip
        return { rows: [{ label_category_id: "cat-2", accepted: "8", rejected: "2" }] };
      }
      if (sql.includes("UPDATE transactions")) {
        updateCalled = true;
      }
      return { rows: [] };
    });
    const fetchUsers = async () => ["user-2"];

    await runAutoSuggestions(queryFn, noopLogger, fetchUsers);
    expect(updateCalled).toBe(false);
  });

  it("skips when confidence < 0.95", async () => {
    let updateCalled = false;
    const queryFn = mock(async (sql: string) => {
      if (sql.includes("label_category_confidence IS NULL")) {
        return { rows: [{ transaction_id: "txn-3", merchant_name: "Gas Station" }] };
      }
      if (sql.includes("SUM(CASE WHEN")) {
        // 3 accepted, 1 rejected → confidence = 3/4 = 0.75 < 0.95 → skip
        return { rows: [{ label_category_id: "cat-3", accepted: "3", rejected: "1" }] };
      }
      if (sql.includes("UPDATE transactions")) {
        updateCalled = true;
      }
      return { rows: [] };
    });
    const fetchUsers = async () => ["user-3"];

    await runAutoSuggestions(queryFn, noopLogger, fetchUsers);
    expect(updateCalled).toBe(false);
  });

  it("applies suggestion and caps confidence at 0.99", async () => {
    let updatedConfidence = 0;
    let updatedCategoryId = "";

    const queryFn = mock(async (sql: string, params?: unknown[]) => {
      if (sql.includes("label_category_confidence IS NULL")) {
        return { rows: [{ transaction_id: "txn-4", merchant_name: "Grocery Store" }] };
      }
      if (sql.includes("SUM(CASE WHEN")) {
        // 10 accepted, 0 rejected → confidence = 1.0 → should cap at 0.99
        return { rows: [{ label_category_id: "cat-groceries", accepted: "10", rejected: "0" }] };
      }
      if (sql.includes("UPDATE transactions") && params) {
        updatedCategoryId = params[0] as string;
        updatedConfidence = params[1] as number;
      }
      return { rows: [] };
    });
    const fetchUsers = async () => ["user-4"];

    await runAutoSuggestions(queryFn, noopLogger, fetchUsers);
    expect(updatedCategoryId).toBe("cat-groceries");
    expect(updatedConfidence).toBe(0.99);
  });

  it("computes exact confidence when ratio is between 0.95 and 0.99", async () => {
    let updatedConfidence = 0;

    const queryFn = mock(async (sql: string, params?: unknown[]) => {
      if (sql.includes("label_category_confidence IS NULL")) {
        return { rows: [{ transaction_id: "txn-5", merchant_name: "Pharmacy" }] };
      }
      if (sql.includes("SUM(CASE WHEN")) {
        // 19 accepted, 1 rejected → confidence = 19/20 = 0.95, reject_rate = 0.05
        return { rows: [{ label_category_id: "cat-health", accepted: "19", rejected: "1" }] };
      }
      if (sql.includes("UPDATE transactions") && params) {
        updatedConfidence = params[1] as number;
      }
      return { rows: [] };
    });
    const fetchUsers = async () => ["user-5"];

    await runAutoSuggestions(queryFn, noopLogger, fetchUsers);
    expect(updatedConfidence).toBeCloseTo(0.95, 5);
  });

  it("caches merchant signal — queries DB only once per unique merchant", async () => {
    let signalQueryCount = 0;

    const queryFn = mock(async (sql: string) => {
      if (sql.includes("label_category_confidence IS NULL")) {
        // Two transactions from the same merchant
        return {
          rows: [
            { transaction_id: "txn-6a", merchant_name: "Bookstore" },
            { transaction_id: "txn-6b", merchant_name: "Bookstore" },
          ],
        };
      }
      if (sql.includes("SUM(CASE WHEN")) {
        signalQueryCount++;
        return { rows: [{ label_category_id: "cat-books", accepted: "5", rejected: "0" }] };
      }
      return { rows: [] };
    });
    const fetchUsers = async () => ["user-6"];

    await runAutoSuggestions(queryFn, noopLogger, fetchUsers);
    expect(signalQueryCount).toBe(1);
  });

  it("uses pg_trgm similarity to fuzzy-match merchant_name variants", async () => {
    let signalSql = "";
    let signalParams: unknown[] = [];

    const queryFn = mock(async (sql: string, params?: unknown[]) => {
      if (sql.includes("label_category_confidence IS NULL")) {
        return { rows: [{ transaction_id: "txn-7", merchant_name: "STARBUCKS #1234" }] };
      }
      if (sql.includes("SUM(CASE WHEN")) {
        signalSql = sql;
        signalParams = params ?? [];
        return { rows: [{ label_category_id: "cat-coffee", accepted: "5", rejected: "0" }] };
      }
      return { rows: [] };
    });
    const fetchUsers = async () => ["user-7"];

    await runAutoSuggestions(queryFn, noopLogger, fetchUsers);
    expect(signalSql).toContain("similarity(merchant_name");
    expect(signalSql).not.toContain("merchant_name = $2");
    // Threshold and limit are passed as parameters, not interpolated
    expect(signalParams).toContain("STARBUCKS #1234");
    expect(signalParams).toContain(0.5);
    expect(signalParams).toContain(30);
  });

  it("continues processing other users when one fails", async () => {
    let user2UnlabeledCalled = false;
    let firstUserSeen = false;

    const errorLogger = {
      info: () => {},
      error: mock(() => {}),
    };

    const queryFn = mock(async (sql: string) => {
      if (sql.includes("label_category_confidence IS NULL")) {
        if (!firstUserSeen) {
          firstUserSeen = true;
          throw new Error("Simulated DB error for first user");
        }
        user2UnlabeledCalled = true;
        return { rows: [] };
      }
      return { rows: [] };
    });
    const fetchUsers = async () => ["fail-user", "ok-user"];

    await expect(runAutoSuggestions(queryFn, errorLogger, fetchUsers)).resolves.toBeUndefined();
    expect(errorLogger.error).toHaveBeenCalledWith(
      "Auto-suggestion failed for user",
      expect.objectContaining({ userId: "fail-user" }),
      expect.any(Error),
    );
    expect(user2UnlabeledCalled).toBe(true);
  });
});
