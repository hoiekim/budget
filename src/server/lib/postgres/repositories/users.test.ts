/**
 * Unit tests for users repository
 * Tests writeUser, searchUser, updateUser, getUserById, deleteUser
 * using pool.query mocks to avoid requiring a live database.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock pool BEFORE importing repository (bun resolves mocks at import time)
// ---------------------------------------------------------------------------

const mockQuery = mock(
  (_sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> =>
    Promise.resolve({ rows: [], rowCount: 0 }),
);

mock.module("../client", () => ({
  pool: { query: mockQuery },
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const fakeClient = { query: mockQuery };
    return fn(fakeClient);
  },
}));

// ---------------------------------------------------------------------------
// Now import the module under test
// ---------------------------------------------------------------------------

import { writeUser, searchUser, updateUser, getUserById, deleteUser } from "./users";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "usr-123",
    username: "hoie",
    password: "$2b$10$hashedpassword",
    email: null,
    expiry: null,
    token: null,
    updated: null,
    is_deleted: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// writeUser
// ---------------------------------------------------------------------------

describe("writeUser", () => {
  test("returns _id on successful upsert", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_id: "usr-abc" }],
      rowCount: 1,
    });

    const result = await writeUser({ username: "hoie", password: "secret123" });
    expect(result).toEqual({ _id: "usr-abc" });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("returns undefined when upsert returns no rows", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await writeUser({ username: "hoie", password: "secret123" });
    expect(result).toBeUndefined();
  });

  test("includes user_id in upsert row when provided", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_id: "usr-explicit" }],
      rowCount: 1,
    });

    const result = await writeUser({
      user_id: "usr-explicit",
      username: "hoie",
      password: "secret123",
    });
    expect(result).toEqual({ _id: "usr-explicit" });
  });

  test("hashes password before storing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: "u1" }], rowCount: 1 });
    await writeUser({ username: "hoie", password: "plaintext" });

    const call = mockQuery.mock.calls[0];
    const sql = call[0] as string;
    const values = call[1] as string[];

    // Password value should NOT be the plaintext
    expect(values).not.toContain("plaintext");
    // SQL should reference users table
    expect(sql).toContain("users");
  });

  test("does not hash when password is undefined", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: "u2" }], rowCount: 1 });
    // Should not throw even without password
    const result = await writeUser({ username: "hoie" } as Parameters<typeof writeUser>[0]);
    expect(result).toEqual({ _id: "u2" });
  });
});

// ---------------------------------------------------------------------------
// searchUser
// ---------------------------------------------------------------------------

describe("searchUser", () => {
  test("returns User when found by user_id", async () => {
    const row = makeUserRow();
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await searchUser({ user_id: "usr-123" });
    expect(result).toBeDefined();
    expect(result?.user_id).toBe("usr-123");
    expect(result?.username).toBe("hoie");
  });

  test("returns User when found by username", async () => {
    const row = makeUserRow({ username: "hoie" });
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await searchUser({ username: "hoie" });
    expect(result?.username).toBe("hoie");
  });

  test("returns undefined when no rows returned", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await searchUser({ user_id: "nonexistent" });
    expect(result).toBeUndefined();
  });

  test("returns undefined and skips query when no filters provided", async () => {
    const result = await searchUser({});
    expect(result).toBeUndefined();
    // query should not have been called
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateUser
// ---------------------------------------------------------------------------

describe("updateUser", () => {
  test("returns true when update succeeds", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: "usr-123" }], rowCount: 1 });

    const result = await updateUser({ user_id: "usr-123", username: "newname" });
    expect(result).toBe(true);
  });

  test("returns false when no rows updated", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await updateUser({ user_id: "usr-123", username: "newname" });
    expect(result).toBe(false);
  });

  test("returns false when no updates provided (empty object)", async () => {
    const result = await updateUser({ user_id: "usr-123" });
    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("hashes password when included in update", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: "usr-123" }], rowCount: 1 });

    await updateUser({ user_id: "usr-123", password: "newpassword" });

    const values = mockQuery.mock.calls[0][1] as string[];
    expect(values).not.toContain("newpassword");
  });
});

// ---------------------------------------------------------------------------
// getUserById
// ---------------------------------------------------------------------------

describe("getUserById", () => {
  test("returns User when found", async () => {
    const row = makeUserRow({ user_id: "usr-456" });
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await getUserById("usr-456");
    expect(result?.user_id).toBe("usr-456");
  });

  test("returns undefined when not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getUserById("nonexistent");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deleteUser
// ---------------------------------------------------------------------------

describe("deleteUser", () => {
  test("returns true when deletion succeeds (rowCount > 0)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: "usr-123" }], rowCount: 1 });
    const result = await deleteUser("usr-123");
    expect(result).toBe(true);
  });

  test("returns false when no row deleted (rowCount = 0)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await deleteUser("nonexistent");
    expect(result).toBe(false);
  });

  test("returns false when rowCount is null", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: null });
    const result = await deleteUser("usr-123");
    expect(result).toBe(false);
  });
});
