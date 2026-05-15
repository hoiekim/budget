/**
 * Tests for POST /api/api-keys (Closes #358 — POST coverage).
 *
 * Mocking pattern: monkey-patch `apiKeysTable.insert` (the lowest-level
 * write the route's `createApiKey` helper performs), following the same
 * approach as `accounts/post-suggest-category.test.ts`. Avoids
 * `mock.module("server", ...)` because Bun's module mock is process-wide
 * and leaks into sibling test files in the same run.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

import { apiKeysTable } from "server/lib/postgres/models";
import { postApiKeysRoute } from "./post-api-keys";

const originalInsert = apiKeysTable.insert.bind(apiKeysTable);

const mockInsert = mock(
  async (
    _row: unknown,
    _returning?: string[],
  ): Promise<Record<string, unknown> | null> => ({ key_id: "k-1" }),
);

(apiKeysTable as unknown as { insert: typeof mockInsert }).insert = mockInsert;

afterAll(() => {
  (apiKeysTable as unknown as { insert: typeof originalInsert }).insert = originalInsert;
});

beforeEach(() => {
  mockInsert.mockReset();
  mockInsert.mockResolvedValue({ key_id: "k-1" });
});

function makeReq(body: unknown, opts: { user?: { user_id: string; username: string } | null } = {}) {
  const user =
    opts.user === undefined ? { user_id: "u-1", username: "test" } : opts.user;
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

describe("post-api-keys", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postApiKeysRoute.execute(makeReq({}, { user: null }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/);
    expect(mockInsert).not.toHaveBeenCalled();
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
    mockInsert.mockResolvedValueOnce({ key_id: "k-42" });

    const result = await postApiKeysRoute.execute(
      makeReq({ name: "  laptop  ", scopes: ["transactions:suggest"] }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(result?.body?.key_id).toBe("k-42");
    // Plaintext is generated client-side here; verify the bk_ scheme is preserved.
    expect(result?.body?.plaintext.startsWith("bk_")).toBe(true);
    expect(result?.body?.prefix).toBe(result!.body!.plaintext.slice(0, 11));

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const [row] = mockInsert.mock.calls[0] as [Record<string, unknown>, string[]];
    expect(row.user_id).toBe("u-1");
    expect(row.name).toBe("laptop");
    expect(row.scopes).toEqual(["transactions:suggest"]);
    expect(row.expires_at).toBeNull();
  });

  test("plaintext is generated each request and never persisted", async () => {
    mockInsert.mockResolvedValueOnce({ key_id: "k-1" });
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: ["transactions:suggest"] }),
      fakeRes(),
    );
    const plaintext = result?.body?.plaintext;
    expect(plaintext).toBeDefined();

    const [row] = mockInsert.mock.calls[0] as [Record<string, unknown>, string[]];
    // The DB row stores a hash + prefix; the raw plaintext must never be persisted.
    expect(Object.values(row).some((v) => v === plaintext)).toBe(false);
    expect(row.key_hash).toBeDefined();
    expect(row.key_prefix).toBe(plaintext!.slice(0, 11));
  });

  test("happy path normalizes a valid future expires_at to ISO", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: ["transactions:suggest"], expires_at: future }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    const [row] = mockInsert.mock.calls[0] as [Record<string, unknown>, string[]];
    expect(row.expires_at).toBe(future);
  });

  test("insert returning null surfaces as a Route-layer failure", async () => {
    // `createApiKey` throws when `apiKeysTable.insert` resolves to null.
    // The Route layer catches the throw and returns an error envelope —
    // pin that the failure is surfaced (not silently turned into success).
    mockInsert.mockResolvedValueOnce(null);
    const result = await postApiKeysRoute.execute(
      makeReq({ name: "k", scopes: ["transactions:suggest"] }),
      fakeRes(),
    );
    expect(result?.status).not.toBe("success");
  });
});
