import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakePg, restoreLeaves } from "test-helpers";

const { pg, mockQuery, resetQueryMocks } = createFakePg();

mock.module("pg", () => pg);

mock.module("bcrypt", () => ({
  default: { hash: async (s: string) => `hashed:${s}` },
}));

// Dynamic-import after the leaf-dep mocks register, so the source
// resolves pg/bcrypt to their FakePool / fake bcrypt.
const { writeUser, searchUser, getUserById, deleteUser } = await import("./users");

afterAll(restoreLeaves);

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
  resetQueryMocks();
});

describe("writeUser", () => {
  test("returns _id on successful upsert", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: "usr-abc" }], rowCount: 1 });
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
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: "usr-explicit" }], rowCount: 1 });
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
    expect(values).not.toContain("plaintext");
    expect(sql).toContain("users");
  });

  test("does not hash when password is undefined", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: "u2" }], rowCount: 1 });
    const result = await writeUser({ username: "hoie" } as Parameters<typeof writeUser>[0]);
    expect(result).toEqual({ _id: "u2" });
  });
});

describe("searchUser", () => {
  test("returns User when found by user_id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeUserRow()], rowCount: 1 });
    const result = await searchUser({ user_id: "usr-123" });
    expect(result?.user_id).toBe("usr-123");
    expect(result?.username).toBe("hoie");
  });

  test("returns User when found by username", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeUserRow({ username: "hoie" })], rowCount: 1 });
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
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("getUserById", () => {
  test("returns User when found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeUserRow({ user_id: "usr-456" })], rowCount: 1 });
    const result = await getUserById("usr-456");
    expect(result?.user_id).toBe("usr-456");
  });

  test("returns undefined when not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getUserById("nonexistent");
    expect(result).toBeUndefined();
  });
});

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
