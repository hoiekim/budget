// builds api_keys.ts into a unique bundle with `pg` kept external, and
// registers a `mock.module` redirect in the preload so this file's
// natural `import { … } from "./api_keys"` lands on the bundle. The
// bundle captures THIS test's `pg` mock at its first load, so other
// bundled tests in the same `bun test` process can mock `pg`
// differently without colliding.
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

// Dynamic-import so the leaf-dep mocks above are registered BEFORE the
// bundle (which the preload redirects this path to) loads. The path is
// still the natural sibling source — only the import shape changes.
const { generateApiKey, hashApiKey, createApiKey, listApiKeys, revokeApiKey, verifyApiKey } =
  await import("./api_keys");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockReset();
});

describe("generateApiKey", () => {
  test("returns plaintext, hash, and prefix with the bk_ scheme", () => {
    const k = generateApiKey();
    expect(k.plaintext.startsWith("bk_")).toBe(true);
    expect(k.plaintext.length).toBe(46);
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.prefix.length).toBe(11);
    expect(k.prefix).toBe(k.plaintext.slice(0, 11));
    expect(hashApiKey(k.plaintext)).toBe(k.hash);
  });

  test("each call produces a unique plaintext + hash", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("createApiKey", () => {
  test("inserts a row and returns the plaintext once", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ key_id: "k-1" }], rowCount: 1 });
    const created = await createApiKey({
      user_id: "u-1",
      name: "claoie",
      scopes: ["transactions:suggest"],
    });
    expect(created.key_id).toBe("k-1");
    expect(created.plaintext.startsWith("bk_")).toBe(true);
    expect(created.prefix).toBe(created.plaintext.slice(0, 11));

    const [, values] = mockQuery.mock.calls[0];
    expect((values as unknown[]).some((v) => v === created.plaintext)).toBe(false);
    expect(values).toContain(hashApiKey(created.plaintext));
  });

  test("throws if upsert returns no row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      createApiKey({ user_id: "u-1", name: "n", scopes: ["s"] }),
    ).rejects.toThrow();
  });
});

describe("listApiKeys", () => {
  test("returns rows scoped to user, omitting key_hash", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          key_id: "k-1",
          user_id: "u-1",
          name: "claoie",
          key_prefix: "bk_abc1234",
          scopes: ["transactions:suggest"],
          created_at: "2026-05-04T00:00:00Z",
          last_used_at: null,
          revoked_at: null,
          expires_at: null,
        },
      ],
      rowCount: 1,
    });
    const out = await listApiKeys("u-1");
    expect(out).toHaveLength(1);
    expect(out[0].key_id).toBe("k-1");
    expect("key_hash" in out[0]).toBe(false);

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain("FROM api_keys");
    expect(sql).toContain("revoked_at IS NULL");
    expect(values).toEqual(["u-1"]);
  });
});

describe("revokeApiKey", () => {
  test("returns true when row updated", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ key_id: "k-1" }], rowCount: 1 });
    expect(await revokeApiKey("k-1", "u-1")).toBe(true);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain("UPDATE api_keys SET revoked_at");
    expect(sql).toContain("revoked_at IS NULL");
    expect(values).toEqual(["k-1", "u-1"]);
  });

  test("returns false when no rows match", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await revokeApiKey("k-x", "u-1")).toBe(false);
  });
});

describe("verifyApiKey", () => {
  const validRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    key_id: "k-1",
    user_id: "u-1",
    key_hash: "",
    scopes: ["transactions:suggest"],
    revoked_at: null,
    expires_at: null,
    ...overrides,
  });

  test("returns null for non-bk_-prefixed input", async () => {
    expect(await verifyApiKey("not-a-key")).toBeNull();
  });

  test("returns null when no row matches the hash", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const k = generateApiKey();
    expect(await verifyApiKey(k.plaintext)).toBeNull();
  });

  test("returns key info on a match, and touches last_used_at", async () => {
    const k = generateApiKey();
    mockQuery.mockResolvedValueOnce({
      rows: [validRow({ key_hash: k.hash })],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await verifyApiKey(k.plaintext);
    expect(result).toEqual({
      key_id: "k-1",
      user_id: "u-1",
      scopes: ["transactions:suggest"],
    });

    await new Promise((r) => setTimeout(r, 5));
    const lastCall = mockQuery.mock.calls.at(-1);
    expect(lastCall?.[0]).toContain("last_used_at");
  });

  test("returns null when revoked", async () => {
    const k = generateApiKey();
    mockQuery.mockResolvedValueOnce({
      rows: [validRow({ key_hash: k.hash, revoked_at: "2026-01-01T00:00:00Z" })],
      rowCount: 1,
    });
    expect(await verifyApiKey(k.plaintext)).toBeNull();
  });

  test("returns null when expired", async () => {
    const k = generateApiKey();
    const past = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    mockQuery.mockResolvedValueOnce({
      rows: [validRow({ key_hash: k.hash, expires_at: past })],
      rowCount: 1,
    });
    expect(await verifyApiKey(k.plaintext)).toBeNull();
  });
});
