// Per-test-bundle isolation — see scripts/test-bundled/.
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { bundleOf } from "test-bundled";

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

const { postApiKeysRoute } = await bundleOf<typeof import("./post\-api\-keys")>(import.meta.url);

beforeEach(() => {
  mockQuery.mockReset();
});

function makeReq(body: unknown, opts: { user?: { user_id: string; username: string } | null } = {}) {
  const user = opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
  return {
    method: "POST",
    path: "/api-keys",
    url: "http://x/api/api-keys",
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
  } as unknown as Parameters<typeof postApiKeysRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postApiKeysRoute.execute>[1];

/** Find the INSERT INTO api_keys SQL call and return its parameters. */
const findInsertCall = (): { sql: string; values: unknown[] } | null => {
  for (const call of mockQuery.mock.calls) {
    const sql = call[0] as string;
    if (/INSERT\s+INTO\s+api_keys/i.test(sql)) return { sql, values: call[1] as unknown[] };
  }
  return null;
};

describe("post-api-keys", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postApiKeysRoute.execute(makeReq({}, { user: null }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects missing body", async () => {
    const result = await postApiKeysRoute.execute(makeReq(null), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Body must be JSON/);
  });

  test("rejects missing name", async () => {
    const result = await postApiKeysRoute.execute(
      makeReq({ scopes: ["transactions:suggest"] }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/name is required/);
  });

  test("rejects empty/whitespace name", async () => {
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "   ", scopes: ["transactions:suggest"] }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/name is required/);
  });

  test("rejects non-string name", async () => {
    const result = await postApiKeysRoute.execute(
      makeReq({ name: 42, scopes: ["transactions:suggest"] }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/name is required/);
  });

  test("rejects name longer than 255 chars", async () => {
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "x".repeat(256), scopes: ["transactions:suggest"] }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/255 characters/);
  });

  test("rejects missing scopes array", async () => {
    const result = await postApiKeysRoute.execute(makeReq({ name: "k" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/scopes must be a non-empty string array/);
  });

  test("rejects empty scopes array", async () => {
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: [] }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/scopes must be a non-empty string array/);
  });

  test("rejects non-string-array scopes", async () => {
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: [1, 2] }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/scopes must be a non-empty string array/);
  });

  test("rejects unknown scope", async () => {
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: ["foo:bar"] }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/Unknown scope: foo:bar/);
  });

  test("rejects non-string expires_at", async () => {
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: ["transactions:suggest"], expires_at: 12345 }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/expires_at must be an ISO timestamp string/);
  });

  test("rejects unparseable expires_at", async () => {
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: ["transactions:suggest"], expires_at: "not-a-date" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not a valid ISO timestamp/);
  });

  test("rejects expires_at in the past", async () => {
    const result = await postApiKeysRoute.execute(
      makeReq({
        name: "k",
        scopes: ["transactions:suggest"],
        expires_at: "2000-01-01T00:00:00.000Z",
      }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/must be in the future/);
  });

  test("happy path returns key_id + prefix + plaintext, trimmed name", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ key_id: "k-42" }], rowCount: 1 });

    const result = await postApiKeysRoute.execute(
      makeReq({ name: "  laptop  ", scopes: ["transactions:suggest"] }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(result?.body?.key_id).toBe("k-42");
    // Plaintext is generated server-side; verify the bk_ scheme is preserved.
    expect(result?.body?.plaintext.startsWith("bk_")).toBe(true);
    expect(result?.body?.prefix).toBe(result!.body!.plaintext.slice(0, 11));

    const ins = findInsertCall();
    expect(ins).not.toBeNull();
    // INSERT carries the row fields: user_id, trimmed name, scopes array,
    // null expires_at, plus the derived key_hash + key_prefix.
    expect(ins!.values).toContain("u-1");
    expect(ins!.values).toContain("laptop");
    expect(ins!.values.find((v) => Array.isArray(v))).toEqual(["transactions:suggest"]);
    expect(ins!.values).toContain(null);
  });

  test("plaintext is generated each request and never persisted", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ key_id: "k-1" }], rowCount: 1 });
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: ["transactions:suggest"] }),
      fakeRes(),
    );
    const plaintext = result?.body?.plaintext;
    expect(plaintext).toBeDefined();

    const ins = findInsertCall();
    expect(ins).not.toBeNull();
    // The raw plaintext must NEVER appear in the persisted row.
    expect(ins!.values).not.toContain(plaintext);
    // The derived prefix (11-char public identifier) MUST appear.
    expect(ins!.values).toContain(plaintext!.slice(0, 11));
  });

  test("happy path normalizes a valid future expires_at to ISO", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    mockQuery.mockResolvedValueOnce({ rows: [{ key_id: "k-1" }], rowCount: 1 });
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: ["transactions:suggest"], expires_at: future }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    const ins = findInsertCall();
    expect(ins).not.toBeNull();
    expect(ins!.values).toContain(future);
  });

  test("insert returning null surfaces as a Route-layer failure", async () => {
    // INSERT … RETURNING * with no row → `createApiKey` throws → Route
    // surfaces an error envelope rather than success.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: ["transactions:suggest"] }),
      fakeRes(),
    );
    expect(result?.status).not.toBe("success");
  });
});
