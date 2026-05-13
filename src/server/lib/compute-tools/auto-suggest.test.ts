import { describe, it, expect, mock } from "bun:test";
import { runAutoSuggestions } from "./auto-suggest";

// Dependency-injection style: pass mock queryFn + logger + fetchUsers + fetchUnlabeled + applyLabel
// directly to runAutoSuggestions. This avoids module mocking which can break other test files.
//
// `queryFn` is only used for the merchant-signal SELECT (custom SQL with pg_trgm `similarity` and
// `SUM(CASE WHEN ...)` aggregation). The unlabeled fetch and the label-apply now go through
// `transactionsTable.query` / `transactionsTable.update`, injected here as `fetchUnlabeled` and
// `applyLabel`.

const noopLogger = {
  info: () => {},
  error: mock(() => {}),
};

type ApplyCall = {
  transactionId: string;
  userId: string;
  labelCategoryId: string;
  labelBudgetId: string;
  labelCategoryConfidence: number;
};

describe("runAutoSuggestions", () => {
  it("skips when no users found", async () => {
    const queryFn = mock(async () => ({ rows: [] }));
    const fetchUsers = mock(async () => []);
    const fetchUnlabeled = mock(async () => []);
    const applyLabel = mock(async () => {});
    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      async () => [],
      async () => {},
    );
    expect(fetchUsers).toHaveBeenCalledTimes(1);
    expect(fetchUnlabeled).toHaveBeenCalledTimes(0);
    expect(applyLabel).toHaveBeenCalledTimes(0);
    expect(queryFn).toHaveBeenCalledTimes(0);
  });

  it("skips transaction when total_labeled < 3", async () => {
    const applyCalls: ApplyCall[] = [];
    const queryFn = mock(async () => {
      // Only 2 labeled — below threshold of 3
      return { rows: [{ label_category_id: "cat-1", label_budget_id: "bud-1", accepted: "2", rejected: "0" }] };
    });
    const fetchUsers = async () => ["user-1"];
    const fetchUnlabeled = async () => [{ transaction_id: "txn-1", merchant_name: "Coffee Shop" }];
    const applyLabel = async (
      transactionId: string,
      userId: string,
      labelCategoryId: string,
      labelBudgetId: string,
      labelCategoryConfidence: number,
    ) => {
      applyCalls.push({ transactionId, userId, labelCategoryId, labelBudgetId, labelCategoryConfidence });
    };

    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      async () => [],
      async () => {},
    );
    expect(applyCalls).toHaveLength(0);
  });

  it("skips when reject_rate > 0.1", async () => {
    const applyCalls: ApplyCall[] = [];
    const queryFn = mock(async () => {
      // 8 accepted, 2 rejected → reject_rate = 0.2 > 0.1 → skip
      return { rows: [{ label_category_id: "cat-2", label_budget_id: "bud-2", accepted: "8", rejected: "2" }] };
    });
    const fetchUsers = async () => ["user-2"];
    const fetchUnlabeled = async () => [{ transaction_id: "txn-2", merchant_name: "Restaurant" }];
    const applyLabel = async (
      transactionId: string,
      userId: string,
      labelCategoryId: string,
      labelBudgetId: string,
      labelCategoryConfidence: number,
    ) => {
      applyCalls.push({ transactionId, userId, labelCategoryId, labelBudgetId, labelCategoryConfidence });
    };

    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      async () => [],
      async () => {},
    );
    expect(applyCalls).toHaveLength(0);
  });

  it("skips when confidence < 0.95", async () => {
    const applyCalls: ApplyCall[] = [];
    const queryFn = mock(async () => {
      // 3 accepted, 1 rejected → confidence = 3/4 = 0.75 < 0.95 → skip
      return { rows: [{ label_category_id: "cat-3", label_budget_id: "bud-3", accepted: "3", rejected: "1" }] };
    });
    const fetchUsers = async () => ["user-3"];
    const fetchUnlabeled = async () => [{ transaction_id: "txn-3", merchant_name: "Gas Station" }];
    const applyLabel = async (
      transactionId: string,
      userId: string,
      labelCategoryId: string,
      labelBudgetId: string,
      labelCategoryConfidence: number,
    ) => {
      applyCalls.push({ transactionId, userId, labelCategoryId, labelBudgetId, labelCategoryConfidence });
    };

    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      async () => [],
      async () => {},
    );
    expect(applyCalls).toHaveLength(0);
  });

  it("applies suggestion and caps confidence at 0.99", async () => {
    const applyCalls: ApplyCall[] = [];
    const queryFn = mock(async () => {
      // 10 accepted, 0 rejected → confidence = 1.0 → should cap at 0.99
      return { rows: [{ label_category_id: "cat-groceries", label_budget_id: "bud-household", accepted: "10", rejected: "0" }] };
    });
    const fetchUsers = async () => ["user-4"];
    const fetchUnlabeled = async () => [{ transaction_id: "txn-4", merchant_name: "Grocery Store" }];
    const applyLabel = async (
      transactionId: string,
      userId: string,
      labelCategoryId: string,
      labelBudgetId: string,
      labelCategoryConfidence: number,
    ) => {
      applyCalls.push({ transactionId, userId, labelCategoryId, labelBudgetId, labelCategoryConfidence });
    };

    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      async () => [],
      async () => {},
    );
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].labelCategoryId).toBe("cat-groceries");
    expect(applyCalls[0].labelCategoryConfidence).toBe(0.99);
    expect(applyCalls[0].transactionId).toBe("txn-4");
    expect(applyCalls[0].userId).toBe("user-4");
  });

  it("computes exact confidence when ratio is between 0.95 and 0.99", async () => {
    const applyCalls: ApplyCall[] = [];
    const queryFn = mock(async () => {
      // 19 accepted, 1 rejected → confidence = 19/20 = 0.95, reject_rate = 0.05
      return { rows: [{ label_category_id: "cat-health", label_budget_id: "bud-medical", accepted: "19", rejected: "1" }] };
    });
    const fetchUsers = async () => ["user-5"];
    const fetchUnlabeled = async () => [{ transaction_id: "txn-5", merchant_name: "Pharmacy" }];
    const applyLabel = async (
      transactionId: string,
      userId: string,
      labelCategoryId: string,
      labelBudgetId: string,
      labelCategoryConfidence: number,
    ) => {
      applyCalls.push({ transactionId, userId, labelCategoryId, labelBudgetId, labelCategoryConfidence });
    };

    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      async () => [],
      async () => {},
    );
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].labelCategoryConfidence).toBeCloseTo(0.95, 5);
  });

  it("caches merchant signal — queries DB only once per unique merchant", async () => {
    let signalQueryCount = 0;
    const queryFn = mock(async () => {
      signalQueryCount++;
      return { rows: [{ label_category_id: "cat-books", label_budget_id: "bud-leisure", accepted: "5", rejected: "0" }] };
    });
    const fetchUsers = async () => ["user-6"];
    const fetchUnlabeled = async () => [
      { transaction_id: "txn-6a", merchant_name: "Bookstore" },
      { transaction_id: "txn-6b", merchant_name: "Bookstore" },
    ];
    const applyLabel = async () => {};

    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      async () => [],
      async () => {},
    );
    expect(signalQueryCount).toBe(1);
  });

  it("uses pg_trgm similarity to fuzzy-match merchant_name variants", async () => {
    let signalSql = "";
    let signalParams: unknown[] = [];

    const queryFn = mock(async (sql: string, params?: unknown[]) => {
      signalSql = sql;
      signalParams = params ?? [];
      return { rows: [{ label_category_id: "cat-coffee", label_budget_id: "bud-discretionary", accepted: "5", rejected: "0" }] };
    });
    const fetchUsers = async () => ["user-7"];
    const fetchUnlabeled = async () => [{ transaction_id: "txn-7", merchant_name: "STARBUCKS #1234" }];
    const applyLabel = async () => {};

    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      async () => [],
      async () => {},
    );
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

    const queryFn = mock(async () => ({ rows: [] }));
    const fetchUsers = async () => ["fail-user", "ok-user"];
    const fetchUnlabeled = async () => {
      if (!firstUserSeen) {
        firstUserSeen = true;
        throw new Error("Simulated DB error for first user");
      }
      user2UnlabeledCalled = true;
      return [];
    };
    const applyLabel = async () => {};

    await expect(
      runAutoSuggestions(
        queryFn,
        errorLogger,
        fetchUsers,
        fetchUnlabeled,
        applyLabel,
        async () => [],
        async () => {},
      ),
    ).resolves.toBeUndefined();
    expect(errorLogger.error).toHaveBeenCalledWith(
      "Auto-suggestion failed for user",
      expect.objectContaining({ userId: "fail-user" }),
      expect.any(Error),
    );
    expect(user2UnlabeledCalled).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Split-transactions pass (#334)
  // ──────────────────────────────────────────────────────────────────────

  type SplitApplyCall = {
    splitTransactionId: string;
    userId: string;
    labelCategoryId: string;
    labelBudgetId: string;
    labelCategoryConfidence: number;
  };

  it("applies suggestions to split transactions via the second pass", async () => {
    const splitApplyCalls: SplitApplyCall[] = [];
    const queryFn = mock(async () => ({
      rows: [{ label_category_id: "cat-groceries", label_budget_id: "bud-household", accepted: "10", rejected: "0" }],
    }));
    const fetchUsers = async () => ["user-split-1"];
    const fetchUnlabeled = async () => []; // no top-level transactions to score
    const applyLabel = async () => {};
    const fetchUnlabeledSplits = async () => [
      { split_transaction_id: "split-1", merchant_name: "Grocery Store" },
    ];
    const applyLabelToSplit = async (
      splitTransactionId: string,
      userId: string,
      labelCategoryId: string,
      labelBudgetId: string,
      labelCategoryConfidence: number,
    ) => {
      splitApplyCalls.push({ splitTransactionId, userId, labelCategoryId, labelBudgetId, labelCategoryConfidence });
    };

    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      fetchUnlabeledSplits,
      applyLabelToSplit,
    );

    expect(splitApplyCalls).toHaveLength(1);
    expect(splitApplyCalls[0].splitTransactionId).toBe("split-1");
    expect(splitApplyCalls[0].labelCategoryId).toBe("cat-groceries");
    expect(splitApplyCalls[0].labelBudgetId).toBe("bud-household");
    expect(splitApplyCalls[0].labelCategoryConfidence).toBe(0.99);
  });

  it("reuses the merchant cache between transaction and split passes", async () => {
    // A parent transaction and a split share the same merchant_name. The
    // signal query should fire exactly once even though it's "needed" twice.
    let signalQueryCount = 0;
    const queryFn = mock(async () => {
      signalQueryCount++;
      return { rows: [{ label_category_id: "cat-x", label_budget_id: "bud-x", accepted: "5", rejected: "0" }] };
    });
    const fetchUsers = async () => ["user-cache"];
    const fetchUnlabeled = async () => [{ transaction_id: "txn-1", merchant_name: "Same Merchant" }];
    const applyLabel = async () => {};
    const fetchUnlabeledSplits = async () => [
      { split_transaction_id: "split-1", merchant_name: "Same Merchant" },
    ];
    const applyLabelToSplit = async () => {};

    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      fetchUnlabeledSplits,
      applyLabelToSplit,
    );
    expect(signalQueryCount).toBe(1);
  });

  it("respects the gates on splits the same way as on transactions", async () => {
    // 8 accepted / 2 rejected → reject_rate = 0.2 > 0.1 → skip both passes.
    const queryFn = mock(async () => ({
      rows: [{ label_category_id: "cat-y", label_budget_id: "bud-y", accepted: "8", rejected: "2" }],
    }));
    const fetchUsers = async () => ["user-gates"];
    const fetchUnlabeled = async () => [];
    const applyLabel = async () => {};
    const splitApplyCalls: SplitApplyCall[] = [];
    const fetchUnlabeledSplits = async () => [
      { split_transaction_id: "split-1", merchant_name: "Skip Me" },
    ];
    const applyLabelToSplit = async (...args: Parameters<typeof applyLabelToSplit>) => {
      const [splitTransactionId, userId, labelCategoryId, labelBudgetId, labelCategoryConfidence] = args;
      splitApplyCalls.push({ splitTransactionId, userId, labelCategoryId, labelBudgetId, labelCategoryConfidence });
    };

    await runAutoSuggestions(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchUnlabeled,
      applyLabel,
      fetchUnlabeledSplits,
      applyLabelToSplit,
    );
    expect(splitApplyCalls).toHaveLength(0);
  });
});
