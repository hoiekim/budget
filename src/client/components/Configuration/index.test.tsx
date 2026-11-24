import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { ItemProvider } from "common";
import type { Sharing } from "server";
import { Data, Item, ItemDictionary, PATH } from "client";
import { PlaidLinkProvider } from "client/components";
import {
  buildContext,
  buildRouter,
  renderWithContext,
  resetDom,
  stubFetch,
  type FetchStubRoute,
} from "test-render";
import { Configuration } from ".";

let fetchStub: ReturnType<typeof stubFetch> | undefined;

/**
 * Lets `PlaidLinkProvider` find its script already loaded, so it adds none of
 * its own. The stand-in's type is one no browser runs, so nothing loads it.
 */
const preloadPlaidScript = () => {
  const script = document.createElement("script");
  script.type = "text/plain";
  script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
  document.head.appendChild(script);
  (window as { Plaid?: object }).Plaid = {};
  return () => {
    script.remove();
    delete (window as { Plaid?: object }).Plaid;
  };
};

let removePlaidScript: (() => void) | undefined;

afterEach(() => {
  cleanup();
  fetchStub?.restore();
  fetchStub = undefined;
  removePlaidScript?.();
  removePlaidScript = undefined;
  resetDom();
});

const NO_SERVER_ANSWER = Symbol("no server answer");

const logOut = async (logoutAnswer: unknown) => {
  fetchStub = stubFetch([
    { path: "/api/api-keys", response: { status: "success", body: { api_keys: [] } } },
    ...(logoutAnswer === NO_SERVER_ANSWER ? [] : [{ path: "/api/login", response: logoutAnswer }]),
  ]);
  const signedOut: unknown[] = [];
  const confirm = spyOn(window, "confirm").mockImplementation(() => true);
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  removePlaidScript = preloadPlaidScript();
  try {
    renderWithContext(
      <PlaidLinkProvider>
        <Configuration />
      </PlaidLinkProvider>,
      buildContext({
        user: { user_id: "u-1", username: "alice" },
        setUser: (user) => signedOut.push(user),
        router: buildRouter(PATH.CONFIG).router,
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Logout" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return { signedOut, assigned: assign.mock.calls.map(([url]) => url) };
  } finally {
    confirm.mockRestore();
    assign.mockRestore();
  }
};

describe("Configuration logout", () => {
  it("a single sign-on session goes on to sign out at the identity provider", async () => {
    const logoutUrl = "https://auth.example.com/logout?client_id=budget";
    const { signedOut, assigned } = await logOut({ status: "success", body: { logoutUrl } });
    expect(signedOut).toEqual([undefined]);
    expect(assigned).toEqual([logoutUrl]);
  });

  it("a password session signs out here only", async () => {
    const { signedOut, assigned } = await logOut({ status: "success" });
    expect(signedOut).toEqual([undefined]);
    expect(assigned).toEqual([]);
  });

  it("an error answer from the server still signs out here", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { signedOut, assigned } = await logOut({ status: "error", message: "Internal server error" });
      expect(signedOut).toStrictEqual([undefined]);
      expect(assigned).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it("no answer from the server keeps the user signed in", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { signedOut, assigned } = await logOut(NO_SERVER_ANSWER);
      expect(signedOut).toStrictEqual([]);
      expect(assigned).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});

const ME = { user_id: "u-me", username: "me" };
const ANN = { user_id: "u-ann", username: "ann" };

const plaidItem = (item_id: string, user_id: string) =>
  new Item({ item_id, user_id, provider: ItemProvider.PLAID, institution_id: null });
const manualItem = (item_id: string, user_id: string) =>
  new Item({ item_id, user_id, provider: ItemProvider.MANUAL });

const renderConfiguration = (items: Item[], sharing: Sharing, routes: FetchStubRoute[] = []) => {
  fetchStub = stubFetch([
    { path: "/api/api-keys", response: { status: "success", body: { api_keys: [] } } },
    ...routes,
  ]);
  removePlaidScript = preloadPlaidScript();
  const { router, calls } = buildRouter(PATH.CONFIG);
  const data = new Data({
    items: new ItemDictionary(items.map((item) => [item.id, item])),
    sharing,
  });
  const rendered = renderWithContext(
    <PlaidLinkProvider>
      <Configuration />
    </PlaidLinkProvider>,
    buildContext({ user: ME, data, router }),
  );
  const connections = () =>
    [...rendered.container.querySelectorAll("button.connection")].map((button) => ({
      name: button.querySelector("div")?.textContent?.replace(/ /g, " "),
      owner: button.querySelector(".owner")?.textContent ?? null,
    }));
  return { calls, connections, requests: () => fetchStub!.calls.requests };
};

const SHARING_WITH_ANN: Sharing = { members: [ANN, ME], invitations: [] };
const SHARING_WITH_NOBODY: Sharing = { members: [], invitations: [] };

describe("Configuration connections", () => {
  it("names each connection's owner while the user shares data", () => {
    const { connections } = renderConfiguration(
      [plaidItem("MINE01", ME.user_id), plaidItem("HERS01", ANN.user_id)],
      SHARING_WITH_ANN,
    );
    expect(connections()).toEqual([
      { name: "MINE01  via Plaid", owner: "me" },
      { name: "HERS01  via Plaid", owner: "ann" },
    ]);
  });

  it("names no owner while the user shares with nobody", () => {
    const { connections } = renderConfiguration(
      [plaidItem("MINE01", ME.user_id)],
      SHARING_WITH_NOBODY,
    );
    expect(connections()).toEqual([{ name: "MINE01  via Plaid", owner: null }]);
  });

  it("lists another person's manual accounts as a connection, and keeps the user's own off the list", () => {
    const { connections } = renderConfiguration(
      [manualItem("mine", ME.user_id), manualItem("hers", ANN.user_id)],
      SHARING_WITH_ANN,
    );
    expect(connections()).toEqual([{ name: "Manual Accounts", owner: "ann" }]);
  });

  it("opens the user's own manual accounts, not another person's", async () => {
    const { calls } = renderConfiguration(
      [manualItem("hers", ANN.user_id), manualItem("mine", ME.user_id)],
      SHARING_WITH_ANN,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "See Manual Accounts" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(calls.go.map(({ path, params }) => [path, params?.get("item_id")])).toEqual([
      [PATH.CONNECTION_DETAIL, "mine"],
    ]);
  });

  it("makes the user a manual item of their own when only another person has one", async () => {
    const created = { item_id: "new", user_id: ME.user_id, provider: ItemProvider.MANUAL };
    const { calls, requests } = renderConfiguration(
      [manualItem("hers", ANN.user_id)],
      SHARING_WITH_ANN,
      [{ path: "/api/public-token", response: { status: "success", body: { item: created } } }],
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "See Manual Accounts" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(requests().map(({ method, url }) => `${method} ${url}`)).toContain(
      "POST /api/public-token?provider=manual",
    );
    expect(calls.go.map(({ path, params }) => [path, params?.get("item_id")])).toEqual([
      [PATH.CONNECTION_DETAIL, "new"],
    ]);
  });
});
