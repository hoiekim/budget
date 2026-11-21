import { afterEach, describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { TableName } from "common";
import type { Sharing } from "server";
import { Context, Data } from "client";
import { buildContext, resetDom, stubFetch } from "test-render";
import { useSync } from "./sync";

const ME = { user_id: "u-me", username: "me" };
const ANN = { user_id: "u-ann", username: "ann" };
const SHARING: Sharing = {
  members: [ANN, ME],
  invitations: [{ invitation_id: "inv-1", inviter: ME, invitee: { user_id: "u-cat", username: "cat" } }],
};
const LAST_SYNCED_SHARING_KEY = "budget:lastSyncedSharing";

let fetchStub: ReturnType<typeof stubFetch> | undefined;

afterEach(() => {
  cleanup();
  fetchStub?.restore();
  fetchStub = undefined;
  resetDom();
});

/** Mounts `useSync` over a server that answers accounts and sharing, and fails everything else. */
const mountSync = () => {
  fetchStub = stubFetch([
    { path: "/api/sharing", response: { status: "success", body: SHARING } },
    {
      path: "/api/accounts",
      response: { status: "success", body: { accounts: [], items: [], holdings: [] } },
    },
  ]);
  let data = new Data();
  const context = buildContext({
    user: ME,
    data,
    setData: (next) => {
      data = typeof next === "function" ? next(data) : next;
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Context.Provider, { value: context }, children);
  const { result } = renderHook(() => useSync(), { wrapper });
  return {
    sync: result.current,
    data: () => data,
    paths: () => fetchStub!.calls.requests.map(({ url }) => new URL(url, "http://x").pathname),
  };
};

/** Outlasts the debounce in front of each sync and the fetches behind it. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

describe("useSync and sharing", () => {
  test("a whole sync brings the sharing state in and records whose data the cache now holds", async () => {
    const mounted = mountSync();
    mounted.sync.sync();
    await settle();
    expect(mounted.data().sharing).toEqual(SHARING);
    expect(window.localStorage.getItem(LAST_SYNCED_SHARING_KEY)).toBe("u-ann,u-me");
  });

  test("an invitation event refetches the sharing state and nothing else", async () => {
    const mounted = mountSync();
    mounted.sync.syncDomain(TableName.SharingInvitations);
    await settle();
    expect(mounted.paths()).toEqual(["/api/sharing"]);
    expect(mounted.data().sharing).toEqual(SHARING);
  });

  test("a membership event refetches every table", async () => {
    const mounted = mountSync();
    mounted.sync.syncDomain(TableName.SharingMembers);
    await settle();
    const paths = mounted.paths();
    for (const path of ["/api/sharing", "/api/accounts", "/api/budgets", "/api/transactions"]) {
      expect(paths).toContain(path);
    }
  });

  test("signing out forgets whose data the cache held", async () => {
    const mounted = mountSync();
    mounted.sync.sync();
    await settle();
    await act(async () => {
      await mounted.sync.clean();
    });
    expect(window.localStorage.getItem(LAST_SYNCED_SHARING_KEY)).toBeNull();
    expect(mounted.data().sharing).toEqual({ members: [], invitations: [] });
  });
});
