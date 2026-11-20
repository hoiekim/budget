import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { PATH } from "client";
import { PlaidLinkProvider } from "client/components";
import { buildContext, buildRouter, renderWithContext, resetDom, stubFetch } from "test-render";
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

const logOut = async (logoutAnswer: unknown) => {
  fetchStub = stubFetch([
    { path: "/api/api-keys", response: { status: "success", body: { api_keys: [] } } },
    { path: "/api/login", response: logoutAnswer },
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
});
