import { describe, test, expect } from "bun:test";
import { deriveActiveParams, PATH } from "./router";
import { ScreenType } from "./context";

const p = (init: string) => new URLSearchParams(init);

describe("deriveActiveParams", () => {
  test("returns live params when currentPath matches targetPath (narrow, transitioning)", () => {
    const live = p("account_type=depository");
    const outgoing = p("account_type=investment");
    const out = deriveActiveParams(
      PATH.ACCOUNTS,
      PATH.ACCOUNTS,
      ScreenType.Narrow,
      live,
      outgoing,
    );
    expect(out).toBe(live);
  });

  test("returns live params on wide-screen even when currentPath differs", () => {
    const live = p("account_type=depository");
    const outgoing = p("account_type=investment");
    const out = deriveActiveParams(
      PATH.ACCOUNTS,
      PATH.ACCOUNT_DETAIL,
      ScreenType.Wide,
      live,
      outgoing,
    );
    expect(out).toBe(live);
  });

  test("returns incoming params when narrow AND currentPath differs from targetPath", () => {
    const live = p("account_id=abc");
    const outgoing = p("account_type=investment");
    const out = deriveActiveParams(
      PATH.ACCOUNTS,
      PATH.ACCOUNT_DETAIL,
      ScreenType.Narrow,
      live,
      outgoing,
    );
    expect(out).toBe(outgoing);
  });

  test("foot-gun: passing sibling PATH on steady-state narrow returns incomingParams, not live", () => {
    // The AccountsPage caller mistakenly passing PATH.BUDGETS while
    // the current page IS AccountsPage. currentPath === ACCOUNTS !==
    // BUDGETS, so under narrow it reads incomingParams. This is the
    // documented failure mode of the wrong-PATH arg — the test pins it
    // so the behavior can't silently change.
    const live = p("account_type=depository");
    const outgoing = p("");
    const out = deriveActiveParams(
      PATH.BUDGETS,
      PATH.ACCOUNTS,
      ScreenType.Narrow,
      live,
      outgoing,
    );
    expect(out).toBe(outgoing);
  });

  test("wide-screen keeps live params even with wrong PATH", () => {
    // Wrong PATH under wide-screen still returns live — the target
    // check is short-circuited by `screenType !== Narrow`.
    const live = p("account_type=depository");
    const outgoing = p("");
    const out = deriveActiveParams(
      PATH.BUDGETS,
      PATH.ACCOUNTS,
      ScreenType.Wide,
      live,
      outgoing,
    );
    expect(out).toBe(live);
  });

  test("empty params on both sides — live still returned on match", () => {
    const live = p("");
    const outgoing = p("");
    const out = deriveActiveParams(
      PATH.DASHBOARD,
      PATH.DASHBOARD,
      ScreenType.Narrow,
      live,
      outgoing,
    );
    expect(out).toBe(live);
  });
});
