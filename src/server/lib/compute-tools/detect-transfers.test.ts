import { describe, it, expect, mock } from "bun:test";
import {
  runTransferDetection,
  scoreConfidence,
  type DetectionCandidate,
} from "./detect-transfers";

const noopLogger = {
  info: () => {},
  error: mock(() => {}),
};

type CreateCall = {
  userId: string;
  transactionIdA: string;
  transactionIdB: string;
};

describe("scoreConfidence", () => {
  it("returns 0.7 base for a same-window non-Plaid match", () => {
    expect(scoreConfidence(false, 2)).toBe(0.7);
  });

  it("adds 0.2 when Plaid tagged either side as TRANSFER_*", () => {
    expect(scoreConfidence(true, 2)).toBeCloseTo(0.9);
  });

  it("adds 0.1 same-day boost", () => {
    expect(scoreConfidence(false, 0)).toBeCloseTo(0.8);
  });

  it("stacks Plaid + same-day, capped at 0.99", () => {
    expect(scoreConfidence(true, 0)).toBeCloseTo(0.99);
  });

  it("does not apply same-day boost when delta is 1 day", () => {
    expect(scoreConfidence(false, 1)).toBe(0.7);
  });
});

describe("runTransferDetection", () => {
  it("does nothing when there are no users", async () => {
    const queryFn = mock(async () => ({ rows: [] }));
    const fetchUsers = mock(async () => []);
    const fetchCandidates = mock(async () => [] as DetectionCandidate[]);
    const createPair = mock(async () => {});

    await runTransferDetection(
      queryFn,
      noopLogger,
      fetchUsers,
      fetchCandidates,
      createPair,
    );

    expect(fetchUsers).toHaveBeenCalledTimes(1);
    expect(fetchCandidates).toHaveBeenCalledTimes(0);
    expect(createPair).toHaveBeenCalledTimes(0);
  });

  it("inserts a pair for a single candidate above threshold", async () => {
    const created: CreateCall[] = [];
    const queryFn = mock(async () => ({ rows: [] }));
    const fetchUsers = async () => ["user-1"];
    const fetchCandidates = async (): Promise<DetectionCandidate[]> => [
      {
        transaction_id_a: "txn-a",
        transaction_id_b: "txn-b",
        date_delta: 1,
        is_plaid_transfer: false,
      },
    ];
    const createPair = async (
      userId: string,
      transactionIdA: string,
      transactionIdB: string,
    ) => {
      created.push({ userId, transactionIdA, transactionIdB });
    };

    await runTransferDetection(queryFn, noopLogger, fetchUsers, fetchCandidates, createPair);
    expect(created).toEqual([
      { userId: "user-1", transactionIdA: "txn-a", transactionIdB: "txn-b" },
    ]);
  });

  it("prevents a single transaction from being paired twice in one run", async () => {
    const created: CreateCall[] = [];
    const fetchUsers = async () => ["user-1"];
    const fetchCandidates = async (): Promise<DetectionCandidate[]> => [
      {
        transaction_id_a: "txn-shared",
        transaction_id_b: "txn-1",
        date_delta: 0,
        is_plaid_transfer: false,
      },
      {
        transaction_id_a: "txn-shared",
        transaction_id_b: "txn-2",
        date_delta: 1,
        is_plaid_transfer: false,
      },
      {
        transaction_id_a: "txn-1",
        transaction_id_b: "txn-3",
        date_delta: 0,
        is_plaid_transfer: false,
      },
    ];
    const createPair = async (
      userId: string,
      a: string,
      b: string,
    ) => {
      created.push({ userId, transactionIdA: a, transactionIdB: b });
    };

    await runTransferDetection(
      async () => ({ rows: [] }),
      noopLogger,
      fetchUsers,
      fetchCandidates,
      createPair,
    );

    // First candidate consumes txn-shared and txn-1.
    // Second candidate (txn-shared, txn-2) is skipped because txn-shared is used.
    // Third candidate (txn-1, txn-3) is skipped because txn-1 is used.
    expect(created).toEqual([
      { userId: "user-1", transactionIdA: "txn-shared", transactionIdB: "txn-1" },
    ]);
  });

  it("processes each user independently and isolates failures", async () => {
    const created: CreateCall[] = [];
    const errorLogger = {
      info: () => {},
      error: mock(() => {}),
    };
    const fetchUsers = async () => ["user-bad", "user-good"];
    const fetchCandidates = async (userId: string): Promise<DetectionCandidate[]> => {
      if (userId === "user-bad") throw new Error("boom");
      return [
        {
          transaction_id_a: "g-a",
          transaction_id_b: "g-b",
          date_delta: 0,
          is_plaid_transfer: true,
        },
      ];
    };
    const createPair = async (userId: string, a: string, b: string) => {
      created.push({ userId, transactionIdA: a, transactionIdB: b });
    };

    await runTransferDetection(
      async () => ({ rows: [] }),
      errorLogger,
      fetchUsers,
      fetchCandidates,
      createPair,
    );

    expect(errorLogger.error).toHaveBeenCalledTimes(1);
    expect(created).toEqual([
      { userId: "user-good", transactionIdA: "g-a", transactionIdB: "g-b" },
    ]);
  });

  it("logs but continues when an INSERT throws", async () => {
    const errorLogger = {
      info: () => {},
      error: mock(() => {}),
    };
    const fetchUsers = async () => ["user-1"];
    const fetchCandidates = async (): Promise<DetectionCandidate[]> => [
      {
        transaction_id_a: "a1",
        transaction_id_b: "b1",
        date_delta: 0,
        is_plaid_transfer: false,
      },
      {
        transaction_id_a: "a2",
        transaction_id_b: "b2",
        date_delta: 0,
        is_plaid_transfer: false,
      },
    ];
    let calls = 0;
    const createPair = async () => {
      calls++;
      if (calls === 1) throw new Error("conflict");
    };

    await runTransferDetection(
      async () => ({ rows: [] }),
      errorLogger,
      fetchUsers,
      fetchCandidates,
      createPair,
    );

    expect(calls).toBe(2);
    expect(errorLogger.error).toHaveBeenCalledTimes(1);
  });
});
