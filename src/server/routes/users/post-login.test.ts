//
// bcrypt is in the framework's DEFAULT_NODE_EXTERNALS list, so the
// bundle's `import bcrypt from "bcrypt"` resolves at runtime through
// the real package — same as the original test. Password hash + compare
// run unmocked.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
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

const { postLoginRoute } = await import("./post-login");
const { loginRateLimiter } = await import("server/lib/rate-limit");

afterAll(restoreLeaves);

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
  opts: { regenerateErr?: Error; ip?: string } = {},
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
    ip: opts.ip ?? "127.0.0.1",
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

describe("post-login rate-limiter wiring", () => {
  // The route decides which outcomes cost a slot; the limiter itself is
  // outcome-blind. Nothing but these tests holds the #389 invariant in place,
  // so they drive the real route rather than the limiter directly.
  let ipCounter = 0;
  const nextIp = () => `192.0.2.${++ipCounter}`;

  const attemptLogin = async (ip: string, password: string) => {
    mockQuery.mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 });
    return postLoginRoute.execute(
      makeReq({ username: "alice", password }, { ip }),
      fakeRes(),
    );
  };

  test("wrong passwords charge the limiter — 5 of them lock the IP out", async () => {
    const ip = nextIp();
    expect(loginRateLimiter.isLimited(ip)).toBe(false);

    for (let i = 0; i < 4; i++) {
      const result = await attemptLogin(ip, "wrong-password");
      expect(result?.status).toBe("failed");
    }
    expect(loginRateLimiter.isLimited(ip)).toBe(false);

    await attemptLogin(ip, "wrong-password");
    expect(loginRateLimiter.isLimited(ip)).toBe(true);
  });

  test("a successful login clears the IP's prior failures (the #389 regression)", async () => {
    const ip = nextIp();
    for (let i = 0; i < 4; i++) await attemptLogin(ip, "wrong-password");

    const success = await attemptLogin(ip, REAL_PASSWORD);
    expect(success?.status).toBe("success");

    // Without the reset, these 4 land on top of the earlier 4 and cross the
    // cap of 5. With it, the IP is back to a clean window.
    for (let i = 0; i < 4; i++) await attemptLogin(ip, "wrong-password");
    expect(loginRateLimiter.isLimited(ip)).toBe(false);
  });

  test("a successful login never charges a slot on its own", async () => {
    // The literal shape of #389: signing in from 6 devices inside one window
    // must not lock the IP out.
    const ip = nextIp();
    for (let i = 0; i < 6; i++) {
      const result = await attemptLogin(ip, REAL_PASSWORD);
      expect(result?.status).toBe("success");
      expect(loginRateLimiter.isLimited(ip)).toBe(false);
    }
  });

  test("one IP's failures do not lock out another IP", async () => {
    const locked = nextIp();
    for (let i = 0; i < 5; i++) await attemptLogin(locked, "wrong-password");
    expect(loginRateLimiter.isLimited(locked)).toBe(true);

    const bystander = nextIp();
    expect(loginRateLimiter.isLimited(bystander)).toBe(false);
  });
});
