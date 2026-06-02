import { describe, test, expect } from "bun:test";
import { postHoldingSnapshotRoute } from "./post-holding-snapshot";

function makeReq(body: unknown, userId?: string) {
  return {
    method: "POST",
    path: "/snapshots/holding",
    url: "http://x/api/snapshots/holding",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: userId ? { user_id: userId, username: "test" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postHoldingSnapshotRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postHoldingSnapshotRoute.execute>[1];

describe("post-holding-snapshot validation", () => {
  test("rejects unauthenticated requests", async () => {
    const req = makeReq({ account_id: "a-1", ticker_symbol: "VOO", quantity: 10 });
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/not authenticated/i);
  });

  test("rejects non-object body", async () => {
    const req = makeReq("not-an-object", "u-1");
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
  });

  test("rejects missing account_id in create mode", async () => {
    const req = makeReq({ ticker_symbol: "VOO", quantity: 10 }, "u-1");
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/account_id/i);
  });

  test("rejects missing ticker_symbol in create mode", async () => {
    const req = makeReq({ account_id: "a-1", quantity: 10 }, "u-1");
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/ticker_symbol/i);
  });

  test("rejects missing quantity in create mode", async () => {
    const req = makeReq({ account_id: "a-1", ticker_symbol: "VOO" }, "u-1");
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/quantity/i);
  });

  test("rejects null quantity in create mode", async () => {
    const req = makeReq(
      { account_id: "a-1", ticker_symbol: "VOO", quantity: null },
      "u-1",
    );
    const result = await postHoldingSnapshotRoute.execute(req, fakeRes());
    expect(result).toBeTruthy();
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/quantity/i);
  });
});
