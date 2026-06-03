import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

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

const { postTransferPairRoute } = await import("./post\-transfer\-pair");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
});

function makeReq(
  body: unknown,
  opts: { user?: { user_id: string; username: string } | null } = {},
) {
  const user = opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
  return {
    method: "POST",
    path: "/transfers/pair",
    url: "http://x/api/transfers/pair",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: user ?? undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postTransferPairRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postTransferPairRoute.execute>[1];

describe("post-transfer-pair", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postTransferPairRoute.execute(
      makeReq({ pair_id: "p-1" }, { user: null }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects missing body", async () => {
    const result = await postTransferPairRoute.execute(makeReq(null), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects array body (not an object)", async () => {
    const result = await postTransferPairRoute.execute(makeReq(["x"]), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  describe("confirm-existing-pair branch (pair_id is a string)", () => {
    test("happy path: UPDATE scoped to session user_id, returns the pair_id", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await postTransferPairRoute.execute(
        makeReq({ pair_id: "p-confirm" }),
        fakeRes(),
      );

      expect(result?.status).toBe("success");
      expect(result?.body).toEqual({ pair_id: "p-confirm" });
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/UPDATE transaction_pairs/i);
      expect(sql).toMatch(/SET status = 'confirmed'/);
      expect(sql).toMatch(/WHERE pair_id = \$1\s+AND user_id = \$2/);
      expect(values).toEqual(["p-confirm", "u-1"]);
    });

    test("cross-user confirm: the route uses the session user_id, never a client value", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await postTransferPairRoute.execute(
        makeReq({ pair_id: "p-belongs-to-B" }, { user: { user_id: "u-A", username: "a" } }),
        fakeRes(),
      );
      expect(result?.status).toBe("success");
      const [, values] = mockQuery.mock.calls[0];
      expect(values).toEqual(["p-belongs-to-B", "u-A"]);
      expect(values).not.toContain("u-B");
    });
  });

  describe("new-pair branch (no pair_id)", () => {
    test("rejects missing transaction_id_a", async () => {
      const result = await postTransferPairRoute.execute(
        makeReq({ transaction_id_b: "t-b" }),
        fakeRes(),
      );
      expect(result?.status).toBe("failed");
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test("rejects missing transaction_id_b", async () => {
      const result = await postTransferPairRoute.execute(
        makeReq({ transaction_id_a: "t-a" }),
        fakeRes(),
      );
      expect(result?.status).toBe("failed");
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test("rejects non-string transaction_id_a", async () => {
      const result = await postTransferPairRoute.execute(
        makeReq({ transaction_id_a: 42, transaction_id_b: "t-b" }),
        fakeRes(),
      );
      expect(result?.status).toBe("failed");
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test("happy path with status=confirmed: INSERT scoped to session user_id", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ pair_id: "p-new" }], rowCount: 1 });

      const result = await postTransferPairRoute.execute(
        makeReq({
          transaction_id_a: "t-a",
          transaction_id_b: "t-b",
          status: "confirmed",
        }),
        fakeRes(),
      );

      expect(result?.status).toBe("success");
      expect(result?.body).toEqual({ pair_id: "p-new" });
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO transaction_pairs/i);
      expect(values?.[1]).toBe("u-1");
      expect(values?.[4]).toBe("confirmed");
      const txnIds = [values?.[2], values?.[3]].sort();
      expect(txnIds).toEqual(["t-a", "t-b"]);
    });

    test("status defaults to 'suggested' when absent", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ pair_id: "p-new" }], rowCount: 1 });

      await postTransferPairRoute.execute(
        makeReq({ transaction_id_a: "t-a", transaction_id_b: "t-b" }),
        fakeRes(),
      );
      const [, values] = mockQuery.mock.calls[0];
      expect(values?.[4]).toBe("suggested");
    });

    test("status defaults to 'suggested' when given any non-'confirmed' value", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ pair_id: "p-new" }], rowCount: 1 });

      await postTransferPairRoute.execute(
        makeReq({
          transaction_id_a: "t-a",
          transaction_id_b: "t-b",
          status: "totally-bogus",
        }),
        fakeRes(),
      );
      const [, values] = mockQuery.mock.calls[0];
      expect(values?.[4]).toBe("suggested");
    });

    test("cross-user new pair: route forwards the session user_id, never a client value", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ pair_id: "p-new" }], rowCount: 1 });

      await postTransferPairRoute.execute(
        makeReq(
          { transaction_id_a: "t-a", transaction_id_b: "t-b" },
          { user: { user_id: "u-A", username: "a" } },
        ),
        fakeRes(),
      );
      const [, values] = mockQuery.mock.calls[0];
      expect(values?.[1]).toBe("u-A");
    });
  });
});
