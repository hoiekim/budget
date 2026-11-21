import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Sharing } from "server";
import {
  Account,
  AccountDictionary,
  Context,
  Data,
  Transaction,
  TransactionDictionary,
  globalData,
} from "client";
import { buildContext, resetDom, stubFetch } from "test-render";
import * as realCache from "../indexed-db/service";

// happy-dom has no IndexedDB, so a sync here is always cold. A warm one needs
// a cache to load: the cache service is replaced for this file and put back.
const realCacheSnap = { ...realCache };
let cached: Data | null = null;
let purges = 0;
let cacheLoads = 0;
/** Runs as each cache load returns, with how many there have been. */
let onCacheLoad: (loads: number) => void = () => {};
mock.module("../indexed-db/service", () => ({
  ...realCacheSnap,
  loadAllData: async () => {
    onCacheLoad(++cacheLoads);
    return cached;
  },
  clearAllData: async () => {
    purges += 1;
  },
}));

const { useSync } = await import("./sync");

afterAll(() => {
  mock.module("../indexed-db/service", () => realCacheSnap);
});

const ME = { user_id: "u-me", username: "me" };
const ANN = { user_id: "u-ann", username: "ann" };
const CURSOR = "2026-01-01T00:00:00.000Z";
const CURSOR_KEY = "budget:lastSyncedCursor";
const LAST_SYNCED_SHARING_KEY = "budget:lastSyncedSharing";

const account = (account_id: string) => new Account({ account_id });
const transaction = (transaction_id: string, account_id: string) =>
  new Transaction({ transaction_id, account_id, amount: 1, date: "2026-01-15" });
const holding = (accounts: Account[], transactions: Transaction[], sharing?: Sharing) =>
  new Data({
    accounts: new AccountDictionary(accounts.map((a) => [a.id, a])),
    transactions: new TransactionDictionary(transactions.map((t) => [t.id, t])),
    sharing,
  });

let fetchStub: ReturnType<typeof stubFetch> | undefined;

afterEach(() => {
  cleanup();
  fetchStub?.restore();
  fetchStub = undefined;
  cached = null;
  purges = 0;
  cacheLoads = 0;
  onCacheLoad = () => {};
  globalData.update(new Data());
  resetDom();
});

/**
 * A tab that already shows `shown`, over a browser whose cache holds `cached`
 * under `CURSOR` and was last filled for `cachedFor`. The server now says the
 * user shares with `now`, and has only the user's own account and transaction.
 */
const mountTab = (shown: Data, cachedFor: string, now: Sharing) => {
  window.localStorage.setItem(CURSOR_KEY, CURSOR);
  window.localStorage.setItem(LAST_SYNCED_SHARING_KEY, cachedFor);
  fetchStub = stubFetch([
    { path: "/api/sharing", response: { status: "success", body: now } },
    {
      path: "/api/accounts",
      response: {
        status: "success",
        body: { accounts: [{ account_id: "acc-mine" }], items: [], holdings: [] },
      },
    },
    {
      path: "/api/transactions",
      response: {
        status: "success",
        body: {
          transactions: [
            { transaction_id: "tx-mine", account_id: "acc-mine", amount: 1, date: "2026-01-15" },
          ],
          investmentTransactions: [],
        },
      },
    },
  ]);
  let data = shown;
  data.status.isInit = true;
  globalData.update(data);
  const context = buildContext({
    user: ME,
    data,
    // As the app's own `setData` does, keep the tab-wide mirror in step.
    setData: (next) => {
      data = typeof next === "function" ? next(data) : next;
      globalData.update(data);
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Context.Provider, { value: context }, children);
  const { result } = renderHook(() => useSync(), { wrapper });
  return {
    sync: result.current.sync,
    data: () => data,
    transactionFetches: () =>
      fetchStub!.calls.requests
        .map(({ url }) => new URL(url, "http://x"))
        .filter(({ pathname }) => pathname === "/api/transactions")
        .map(({ searchParams }) => searchParams.get("start-date")),
  };
};

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

const mine = () => [account("acc-mine")];
const WITH_ANN: Sharing = { members: [ANN, ME], invitations: [] };
const WITH_NOBODY: Sharing = { members: [], invitations: [] };

describe("a warm sync after the sharing group changed", () => {
  test("a tab still showing the old group starts over, though another tab already refilled the cache", async () => {
    cached = holding(mine(), [transaction("tx-mine", "acc-mine")]);
    const shown = holding(
      [...mine(), account("acc-ann")],
      [transaction("tx-mine", "acc-mine"), transaction("tx-ann", "acc-ann")],
      WITH_ANN,
    );
    const tab = mountTab(shown, "", WITH_NOBODY);
    tab.sync();
    await settle();

    expect([...tab.data().transactions.keys()]).toEqual(["tx-mine"]);
    expect([...tab.data().accounts.keys()]).toEqual(["acc-mine"]);
    expect(tab.data().sharing).toEqual(WITH_NOBODY);
    // No fetch resumed from the cursor, and one fetched the whole history.
    expect(tab.transactionFetches()).not.toContain(CURSOR);
    expect(tab.transactionFetches()).toContain(null);
    expect(purges).toBe(1);
  });

  test("the old cursor is gone before the restart, so a restart that fails is not followed by a warm sync", async () => {
    cached = holding(mine(), [transaction("tx-mine", "acc-mine")]);
    const shown = holding(mine(), [transaction("tx-mine", "acc-mine")], WITH_ANN);
    // The stubbed server fails every fetch but three, so this run leaves the cursor as it found it.
    const tab = mountTab(shown, "", WITH_NOBODY);
    tab.sync();
    await settle();

    expect(window.localStorage.getItem(CURSOR_KEY)).toBeNull();
  });

  test("the tab starts over even when another tab's finished sync puts a cursor back meanwhile", async () => {
    cached = holding(mine(), [transaction("tx-mine", "acc-mine")]);
    const shown = holding(
      [...mine(), account("acc-ann")],
      [transaction("tx-mine", "acc-mine"), transaction("tx-ann", "acc-ann")],
      WITH_ANN,
    );
    const tab = mountTab(shown, "", WITH_NOBODY);
    onCacheLoad = (loads) => {
      if (loads > 1) window.localStorage.setItem(CURSOR_KEY, CURSOR);
    };
    tab.sync();
    await settle();

    expect(cacheLoads).toBe(2);
    expect([...tab.data().transactions.keys()]).toEqual(["tx-mine"]);
    expect(tab.transactionFetches()).not.toContain(CURSOR);
  });

  test("the first tab to find the cache stale starts over and records the new group", async () => {
    cached = holding(
      [...mine(), account("acc-ann")],
      [transaction("tx-mine", "acc-mine"), transaction("tx-ann", "acc-ann")],
    );
    const shown = holding(
      [...mine(), account("acc-ann")],
      [transaction("tx-mine", "acc-mine"), transaction("tx-ann", "acc-ann")],
      WITH_ANN,
    );
    const tab = mountTab(shown, "u-ann,u-me", WITH_NOBODY);
    tab.sync();
    await settle();

    expect([...tab.data().transactions.keys()]).toEqual(["tx-mine"]);
    expect(tab.transactionFetches()).not.toContain(CURSOR);
    expect(window.localStorage.getItem(LAST_SYNCED_SHARING_KEY)).toBe("");
    expect(purges).toBe(1);
  });

  test("with the same people sharing, the sync resumes from the cursor and keeps what the tab holds", async () => {
    cached = holding(mine(), [transaction("tx-mine", "acc-mine")]);
    const shown = holding(
      mine(),
      [transaction("tx-mine", "acc-mine"), transaction("tx-older", "acc-mine")],
      WITH_NOBODY,
    );
    const tab = mountTab(shown, "", WITH_NOBODY);
    tab.sync();
    await settle();

    expect([...tab.data().transactions.keys()].sort()).toEqual(["tx-mine", "tx-older"]);
    expect(tab.transactionFetches()).toEqual([CURSOR]);
    expect(purges).toBe(0);
  });
});
