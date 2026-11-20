import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { PATH } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom } from "test-render";
import { LoginPage } from "./LoginPage";

afterEach(() => {
  cleanup();
  resetDom();
});

const render = (sso: { enabled: boolean; localLogin: boolean }, params = new URLSearchParams()) =>
  renderWithContext(<LoginPage />, buildContext({ sso, router: buildRouter(PATH.LOGIN, params).router }));

const hasPasswordForm = () => document.querySelector('input[name="password"]') !== null;
const ssoButton = () => screen.queryByRole("button", { name: "Sign in with SSO" });

describe("LoginPage", () => {
  it("with single sign-on off, shows the password form and nothing else", () => {
    render({ enabled: false, localLogin: true });
    expect(hasPasswordForm()).toBe(true);
    expect(ssoButton()).toBeNull();
    expect(document.querySelector(".LoginPage-error")).toBeNull();
  });

  it("with single sign-on only, offers SSO and hides the password form", () => {
    render({ enabled: true, localLogin: false });
    expect(ssoButton()).not.toBeNull();
    expect(hasPasswordForm()).toBe(false);
  });

  it("with AUTH_LOCAL_LOGIN, offers both", () => {
    render({ enabled: true, localLogin: true });
    expect(ssoButton()).not.toBeNull();
    expect(hasPasswordForm()).toBe(true);
  });

  it("signing in with SSO leaves the app for the provider, coming back to the budgets", () => {
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      render({ enabled: true, localLogin: false });
      fireEvent.click(ssoButton()!);
      expect(assign.mock.calls).toEqual([["/api/auth/login?returnTo=%2Fbudgets"]]);
    } finally {
      assign.mockRestore();
    }
  });

  it.each([
    [
      "account_exists",
      "An account with your username already exists here and is not linked to your SSO account. Ask the administrator to link it.",
    ],
    ["no_access", "Your SSO account does not have access to this app."],
    ["unavailable", "The sign-in service is unavailable. Please try again later."],
    ["something-new", "SSO sign-in failed. Please try again."],
  ])("explains sso_error=%s", (code, message) => {
    render({ enabled: true, localLogin: false }, new URLSearchParams({ sso_error: code }));
    expect(document.querySelector(".LoginPage-error")?.textContent).toBe(message);
  });
});
