/**
 * Tests for POST /api/plaid-hook (Closes #404 — route-level coverage).
 *
 * Mocking pattern: build the route from `createPostPlaidHookRoute({...})`
 * with plain function mocks for every dep the route touches. No
 * `mock.module("server", ...)` — Bun's module mock is process-wide and
 * leaks across sibling test files in the same run.
 */

import { describe, test, expect, mock } from "bun:test";

import {
  createPostPlaidHookRoute,
  type PostPlaidHookDeps,
} from "./post-plaid-hook";

const ITEM_ID = "item-1";

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
  return res as unknown as Parameters<
    ReturnType<typeof createPostPlaidHookRoute>["execute"]
  >[1];
};

function makeReq(
  body: unknown,
  opts: { rawBody?: string; verification?: string } = {},
) {
  return {
    method: "POST",
    path: "/plaid-hook",
    url: "http://x/api/plaid-hook",
    headers: {
      "plaid-verification": opts.verification ?? "valid.jwt",
    },
    query: {},
    body,
    rawBody:
      opts.rawBody !== undefined
        ? opts.rawBody
        : JSON.stringify(body ?? {}),
    session: {
      id: "s-1",
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<
    ReturnType<typeof createPostPlaidHookRoute>["execute"]
  >[0];
}

function makeDeps(
  overrides: Partial<PostPlaidHookDeps> = {},
): PostPlaidHookDeps {
  return {
    verifyWebhook: mock(async () => true),
    syncPlaidTransactions: mock(async () => ({
      added: 1,
      modified: 0,
      removed: 0,
    })) as unknown as PostPlaidHookDeps["syncPlaidTransactions"],
    updateItemStatus: mock(async () => true) as unknown as PostPlaidHookDeps["updateItemStatus"],
    getUserItem: mock(async () => ({
      user: { user_id: "u-1", username: "alice" },
      item: {
        item_id: ITEM_ID,
        access_token: "tok-1",
        institution_id: "ins-1",
        available_products: [],
        billed_products: [],
        consent_expiration_time: null,
        cursor: null,
        plaid_error: null,
        status: "GOOD",
      },
    })) as unknown as PostPlaidHookDeps["getUserItem"],
    upsertItems: mock(async () => undefined) as unknown as PostPlaidHookDeps["upsertItems"],
    getItem: mock(async () => ({
      item_id: ITEM_ID,
      institution_id: "ins-1",
      consented_products: ["transactions"],
      products: ["accounts"],
    })) as unknown as PostPlaidHookDeps["getItem"],
    sendAlarm: mock(async () => undefined) as unknown as PostPlaidHookDeps["sendAlarm"],
    ...overrides,
  };
}

describe("post-plaid-hook auth gate", () => {
  test("missing rawBody → 401 + does not call verifyWebhook", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const res = fakeRes();
    const req = makeReq(
      { webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: ITEM_ID },
      { rawBody: "" },
    );
    const result = await route.execute(req, res);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    expect(result?.status).toBe("failed");
    expect(deps.verifyWebhook).not.toHaveBeenCalled();
    expect(deps.syncPlaidTransactions).not.toHaveBeenCalled();
  });

  test("verifyWebhook returns false → 401, body branching short-circuited", async () => {
    const deps = makeDeps({ verifyWebhook: mock(async () => false) });
    const route = createPostPlaidHookRoute(deps);
    const res = fakeRes();
    const result = await route.execute(
      makeReq({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: ITEM_ID }),
      res,
    );
    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    expect(result?.status).toBe("failed");
    expect(deps.verifyWebhook).toHaveBeenCalledTimes(1);
    expect(deps.syncPlaidTransactions).not.toHaveBeenCalled();
  });

  test("verifyWebhook receives signedJwt from header (undefined → still gets called)", async () => {
    const deps = makeDeps({ verifyWebhook: mock(async () => true) });
    const route = createPostPlaidHookRoute(deps);
    const req = makeReq(
      { webhook_type: "ITEM", webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED", item_id: ITEM_ID },
      { verification: "sig.abc" },
    );
    const result = await route.execute(req, fakeRes());
    expect(deps.verifyWebhook).toHaveBeenCalledWith(req.rawBody, "sig.abc");
    expect(result?.status).toBe("success");
  });

  test("verified + invalid body shape → validationError, no dispatch", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(makeReq(null), fakeRes());
    expect(result?.status).toBe("failed");
    expect(deps.verifyWebhook).toHaveBeenCalledTimes(1);
    expect(deps.syncPlaidTransactions).not.toHaveBeenCalled();
    expect(deps.updateItemStatus).not.toHaveBeenCalled();
  });
});

describe("post-plaid-hook TRANSACTIONS dispatch", () => {
  test("SYNC_UPDATES_AVAILABLE → syncPlaidTransactions called, success", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(deps.syncPlaidTransactions).toHaveBeenCalledWith(ITEM_ID);
  });

  test("SYNC_UPDATES_AVAILABLE + syncPlaidTransactions returns null → failed", async () => {
    const deps = makeDeps({
      syncPlaidTransactions: mock(
        async () => null,
      ) as unknown as PostPlaidHookDeps["syncPlaidTransactions"],
    });
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
  });

  test.each([
    "DEFAULT_UPDATE",
    "INITIAL_UPDATE",
    "HISTORICAL_UPDATE",
    "TRANSACTIONS_REMOVED",
  ])("TRANSACTIONS %s → success without sync side-effect", async (code) => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "TRANSACTIONS", webhook_code: code, item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(deps.syncPlaidTransactions).not.toHaveBeenCalled();
  });

  test("TRANSACTIONS unknown code → no return value (warn path)", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "TRANSACTIONS", webhook_code: "MYSTERY_CODE", item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result).toBeNull();
    expect(deps.syncPlaidTransactions).not.toHaveBeenCalled();
  });
});

describe("post-plaid-hook ITEM dispatch", () => {
  test("WEBHOOK_UPDATE_ACKNOWLEDGED → success without side-effect", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "ITEM", webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED", item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(deps.updateItemStatus).not.toHaveBeenCalled();
  });

  test("PENDING_EXPIRATION → updateItemStatus(BAD) + sendAlarm", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(deps.updateItemStatus).toHaveBeenCalledTimes(1);
    expect(deps.sendAlarm).toHaveBeenCalledTimes(1);
  });

  test("ERROR + ITEM_LOGIN_REQUIRED → updateItemStatus(BAD) + sendAlarm", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: ITEM_ID,
        error: { error_code: "ITEM_LOGIN_REQUIRED" },
      }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(deps.updateItemStatus).toHaveBeenCalledTimes(1);
    expect(deps.sendAlarm).toHaveBeenCalledTimes(1);
  });

  test("ERROR + other error_code → no return (warn path), no side-effect", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: ITEM_ID,
        error: { error_code: "MFA_REQUIRED" },
      }),
      fakeRes(),
    );
    expect(result).toBeNull();
    expect(deps.updateItemStatus).not.toHaveBeenCalled();
  });

  test("PENDING_EXPIRATION + updateItemStatus returns false → failed, sendAlarm not invoked", async () => {
    const deps = makeDeps({
      updateItemStatus: mock(async () => false) as unknown as PostPlaidHookDeps["updateItemStatus"],
    });
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(deps.sendAlarm).not.toHaveBeenCalled();
  });

  test.each(["USER_ACCOUNT_REVOKED", "ITEM_UPDATED"])(
    "%s → refreshItemProducts (getUserItem + plaid.getItem + upsertItems)",
    async (code) => {
      const deps = makeDeps();
      const route = createPostPlaidHookRoute(deps);
      const result = await route.execute(
        makeReq({ webhook_type: "ITEM", webhook_code: code, item_id: ITEM_ID }),
        fakeRes(),
      );
      expect(result?.status).toBe("success");
      expect(deps.getUserItem).toHaveBeenCalledWith(ITEM_ID);
      expect(deps.getItem).toHaveBeenCalledWith("tok-1");
      expect(deps.upsertItems).toHaveBeenCalledTimes(1);
    },
  );

  test("refreshItemProducts when getUserItem returns null → failed", async () => {
    const deps = makeDeps({
      getUserItem: mock(async () => null) as unknown as PostPlaidHookDeps["getUserItem"],
    });
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "ITEM", webhook_code: "ITEM_UPDATED", item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(deps.upsertItems).not.toHaveBeenCalled();
  });

  test("ITEM unknown code → no return (warn path)", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "ITEM", webhook_code: "MYSTERY_ITEM_CODE", item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result).toBeNull();
  });
});

describe("post-plaid-hook HOLDINGS & INVESTMENTS_TRANSACTIONS dispatch", () => {
  test("HOLDINGS DEFAULT_UPDATE → syncPlaidTransactions called", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "HOLDINGS", webhook_code: "DEFAULT_UPDATE", item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    expect(deps.syncPlaidTransactions).toHaveBeenCalledWith(ITEM_ID);
  });

  test("HOLDINGS unknown code → no return (warn path)", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({ webhook_type: "HOLDINGS", webhook_code: "WEIRD", item_id: ITEM_ID }),
      fakeRes(),
    );
    expect(result).toBeNull();
    expect(deps.syncPlaidTransactions).not.toHaveBeenCalled();
  });

  test.each(["DEFAULT_UPDATE", "HISTORICAL_UPDATE"])(
    "INVESTMENTS_TRANSACTIONS %s → syncPlaidTransactions called",
    async (code) => {
      const deps = makeDeps();
      const route = createPostPlaidHookRoute(deps);
      const result = await route.execute(
        makeReq({ webhook_type: "INVESTMENTS_TRANSACTIONS", webhook_code: code, item_id: ITEM_ID }),
        fakeRes(),
      );
      expect(result?.status).toBe("success");
      expect(deps.syncPlaidTransactions).toHaveBeenCalledWith(ITEM_ID);
    },
  );

  test("INVESTMENTS_TRANSACTIONS unknown code → no return (warn path)", async () => {
    const deps = makeDeps();
    const route = createPostPlaidHookRoute(deps);
    const result = await route.execute(
      makeReq({
        webhook_type: "INVESTMENTS_TRANSACTIONS",
        webhook_code: "MYSTERY",
        item_id: ITEM_ID,
      }),
      fakeRes(),
    );
    expect(result).toBeNull();
  });
});
