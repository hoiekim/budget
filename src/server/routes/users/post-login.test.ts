/**
 * Tests for POST /api/login (#393 — partial: post-login.ts coverage).
 *
 * Mocking pattern: monkey-patch `usersTable.queryOne` (the lowest-level
 * read that `searchUser` performs), mirroring `api-keys/post-api-keys.test.ts`.
 * Avoids `mock.module("server", ...)` because Bun's module mock is
 * process-wide and leaks across sibling test files.
 *
 * bcrypt.compare runs unmocked — fixture user passwords are real hashes
 * generated at test-module load.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import bcrypt from "bcrypt";

import { usersTable } from "server/lib/postgres/models";
import { postLoginRoute } from "./post-login";

const REAL_PASSWORD = "correct-horse-battery-staple";
const REAL_HASH = await bcrypt.hash(REAL_PASSWORD, 10);

const realUserRow = {
  user_id: "u-1",
  username: "alice",
  password: REAL_HASH,
  email: null,
  expiry: null,
  token: null,
  updated: "2026-05-19T00:00:00.000Z",
  is_deleted: false,
};

// Fake model object: queryOne callers invoke `.toUser()` (per searchUser) so
// we just need that one method to return the User record.
const makeFakeModel = (row: typeof realUserRow) => ({
  ...row,
  toUser() {
    return { user_id: row.user_id, username: row.username, password: row.password };
  },
  toMaskedUser() {
    return { user_id: row.user_id, username: row.username };
  },
  toJSON() {
    return { user_id: row.user_id, username: row.username };
  },
});

const originalQueryOne = usersTable.queryOne.bind(usersTable);

const mockQueryOne = mock(async (_filters: Record<string, unknown>): Promise<unknown> => null);

(usersTable as unknown as { queryOne: typeof mockQueryOne }).queryOne = mockQueryOne;

afterAll(() => {
  (usersTable as unknown as { queryOne: typeof originalQueryOne }).queryOne = originalQueryOne;
});

beforeEach(() => {
  mockQueryOne.mockReset();
  mockQueryOne.mockResolvedValue(null);
});

interface SessionStub {
  id: string;
  user?: { user_id: string; username: string };
  regenerate: (cb: (err?: Error) => void) => void;
  destroy: (cb?: (err?: Error) => void) => void;
}

function makeReq(
  body: unknown,
  opts: { regenerateErr?: Error } = {},
): Parameters<typeof postLoginRoute.execute>[0] {
  const session: SessionStub = {
    id: "s-1",
    user: undefined,
    regenerate(cb) {
      cb(opts.regenerateErr);
    },
    destroy() {},
  };
  return {
    method: "POST",
    path: "/login",
    url: "http://x/api/login",
    headers: {},
    query: {},
    body,
    session,
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postLoginRoute.execute>[0];
}

const fakeRes = () => {
  const res = {
    statusCode: 200,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    write() {
      return true;
    },
    end() {},
  };
  return res as unknown as Parameters<typeof postLoginRoute.execute>[1];
};

describe("post-login validation", () => {
  test("missing body → validationError", async () => {
    const result = await postLoginRoute.execute(makeReq(null), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/body/i);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test("missing username → validationError", async () => {
    const result = await postLoginRoute.execute(
      makeReq({ password: "x" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/username/);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test("missing password → validationError", async () => {
    const result = await postLoginRoute.execute(
      makeReq({ username: "alice" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/password/);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test("empty-string username → validationError", async () => {
    const result = await postLoginRoute.execute(
      makeReq({ username: "", password: "x" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/username/);
  });
});

describe("post-login auth outcomes", () => {
  test("unknown user → generic failure (no enumeration leak)", async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const result = await postLoginRoute.execute(
      makeReq({ username: "ghost", password: REAL_PASSWORD }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toBe("Invalid username or password.");
    // Verify the search was actually attempted (DUMMY_HASH timing path runs
    // for unknown users — assertion: queryOne was called once).
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test("known user + wrong password → same generic failure (no enumeration leak)", async () => {
    mockQueryOne.mockResolvedValueOnce(makeFakeModel(realUserRow));
    const result = await postLoginRoute.execute(
      makeReq({ username: "alice", password: "WRONG" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toBe("Invalid username or password.");
  });

  test("known user + correct password → success, session.regenerate called, user set", async () => {
    mockQueryOne.mockResolvedValueOnce(makeFakeModel(realUserRow));

    let regenerateCalled = false;
    const session: SessionStub = {
      id: "s-old",
      user: undefined,
      regenerate(cb) {
        regenerateCalled = true;
        cb();
      },
      destroy() {},
    };
    const req = {
      method: "POST",
      path: "/login",
      url: "http://x/api/login",
      headers: {},
      query: {},
      body: { username: "alice", password: REAL_PASSWORD },
      session,
      ip: "127.0.0.1",
    } as unknown as Parameters<typeof postLoginRoute.execute>[0];

    const result = await postLoginRoute.execute(req, fakeRes());
    expect(result?.status).toBe("success");
    expect(result?.body?.user_id).toBe("u-1");
    expect(result?.body?.username).toBe("alice");
    // Hashed password must never leak in the response.
    expect((result?.body as Record<string, unknown> | undefined)?.password).toBeUndefined();
    expect(regenerateCalled).toBe(true);
    expect(session.user?.user_id).toBe("u-1");
  });

  test("session.regenerate callback error → Route layer surfaces error envelope", async () => {
    // The Route base class catches throws and returns
    // { status: "error", message: "Internal server error" } with HTTP 500.
    // Pin: a regenerate failure must NOT be silently turned into success.
    mockQueryOne.mockResolvedValueOnce(makeFakeModel(realUserRow));
    const req = makeReq(
      { username: "alice", password: REAL_PASSWORD },
      { regenerateErr: new Error("boom") },
    );
    const res = fakeRes();
    const result = await postLoginRoute.execute(req, res);
    expect(result?.status).toBe("error");
    expect((res as { statusCode: number }).statusCode).toBe(500);
  });
});
