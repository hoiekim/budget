// Per-test-bundle isolation — see scripts/test-bundled/.
//
// bcrypt is in the framework's DEFAULT_NODE_EXTERNALS list, so the
// bundle's `import bcrypt from "bcrypt"` resolves at runtime through
// the real package — same as the original test. Password hash + compare
// run unmocked.
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { bundleOf } from "test-bundled";
import bcrypt from "bcrypt";

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

const { postLoginRoute } = await bundleOf<typeof import("./post-login")>(import.meta.url);

const REAL_PASSWORD = "correct-horse-battery-staple";
const REAL_HASH = await bcrypt.hash(REAL_PASSWORD, 10);

/** Raw users row matching UserModel's schema. */
const userRow = (overrides: Record<string, unknown> = {}) => ({
  user_id: "u-1",
  username: "alice",
  password: REAL_HASH,
  email: null,
  expiry: null,
  token: null,
  updated: "2026-05-19T00:00:00.000Z",
  is_deleted: false,
  ...overrides,
});

beforeEach(() => {
  mockQuery.mockReset();
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
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("missing username → validationError", async () => {
    const result = await postLoginRoute.execute(makeReq({ password: "x" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/username/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("missing password → validationError", async () => {
    const result = await postLoginRoute.execute(makeReq({ username: "alice" }), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/password/);
    expect(mockQuery).not.toHaveBeenCalled();
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
    // searchUser → usersTable.queryOne → pool.query → empty rows
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await postLoginRoute.execute(
      makeReq({ username: "ghost", password: REAL_PASSWORD }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toBe("Invalid username or password.");
    // searchUser was attempted (DUMMY_HASH timing path still issues one SELECT)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("known user + wrong password → same generic failure (no enumeration leak)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 });
    const result = await postLoginRoute.execute(
      makeReq({ username: "alice", password: "WRONG" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toBe("Invalid username or password.");
  });

  test("known user + correct password → success, session.regenerate called, user set", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 });

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
    mockQuery.mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 });
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
