import { describe, test, expect } from "bun:test";
import { deriveActiveParams, PATH } from "./router";
import { ScreenType } from "./context";

const p = (init: string) => new URLSearchParams(init);

/**
 * The two URLSearchParams args to `deriveActiveParams` come from the
 * router's `params` (steady-state = current URL; mid-transition = STILL
 * outgoing URL because `setParams` is deferred inside `endTransition`
 * behind a `setTimeout`) and `incomingParams` (mid-transition =
 * destination URL, set immediately). The naming below (`paramsLive` /
 * `paramsIncoming`) matches the router state names — NOT
 * "outgoing"/"live", which would mislead about which is which during
 * the animation window. See the JSDoc on `router.getActiveParams`.
 */
describe("deriveActiveParams", () => {
  test("outgoing caller (currentPath still matches its targetPath) under narrow reads params", () => {
    // At mid-transition, `path` still holds the outgoing route → `path
    // === targetPath` succeeds for the outgoing page. It reads
    // `params` (which still holds the outgoing URL). This is what
    // keeps the outgoing dropdown label from flashing empty during
    // slide-out.
    const paramsLive = p("account_type=depository");
    const paramsIncoming = p("account_id=abc");
    const out = deriveActiveParams(
      PATH.ACCOUNTS,
      PATH.ACCOUNTS,
      ScreenType.Narrow,
      paramsLive,
      paramsIncoming,
    );
    expect(out).toBe(paramsLive);
  });

  test("wide-screen bypass — currentPath differs but returns params anyway", () => {
    // Wide-screen skips the animation (`endTransition` runs
    // synchronously), so `screenType !== Narrow` short-circuits and
    // returns `params` regardless of currentPath.
    const paramsLive = p("account_type=depository");
    const paramsIncoming = p("account_id=abc");
    const out = deriveActiveParams(
      PATH.ACCOUNTS,
      PATH.ACCOUNT_DETAIL,
      ScreenType.Wide,
      paramsLive,
      paramsIncoming,
    );
    expect(out).toBe(paramsLive);
  });

  test("incoming caller (currentPath still on outgoing route) under narrow reads incomingParams", () => {
    // At mid-transition, `path` still holds the outgoing route →
    // `path === targetPath` fails for the incoming page. It reads
    // `incomingParams` (which holds the destination URL). This lets
    // the incoming page's title / lookup render its new URL on the
    // first paint of the slide-in, before the delayed `setParams`
    // fires ~300ms later.
    const paramsLive = p("account_type=depository");
    const paramsIncoming = p("account_id=abc");
    const out = deriveActiveParams(
      PATH.ACCOUNT_DETAIL,
      PATH.ACCOUNTS,
      ScreenType.Narrow,
      paramsLive,
      paramsIncoming,
    );
    expect(out).toBe(paramsIncoming);
  });

  test("foot-gun: passing sibling PATH on steady-state narrow returns incomingParams, not params", () => {
    // Bug case — the AccountsPage caller mistakenly passing
    // PATH.BUDGETS while the current page IS AccountsPage.
    // currentPath === ACCOUNTS !== BUDGETS, so under narrow it reads
    // incomingParams. The dropdown then never picks up URL changes
    // from AccountsPage. Pinning the behavior so a future refactor
    // can't silently change it.
    const paramsLive = p("account_type=depository");
    const paramsIncoming = p("");
    const out = deriveActiveParams(
      PATH.BUDGETS,
      PATH.ACCOUNTS,
      ScreenType.Narrow,
      paramsLive,
      paramsIncoming,
    );
    expect(out).toBe(paramsIncoming);
  });

  test("wide-screen keeps params even with wrong PATH", () => {
    // Wrong PATH under wide-screen still returns params — the target
    // check is short-circuited by `screenType !== Narrow`. So the
    // foot-gun only bites under narrow.
    const paramsLive = p("account_type=depository");
    const paramsIncoming = p("");
    const out = deriveActiveParams(
      PATH.BUDGETS,
      PATH.ACCOUNTS,
      ScreenType.Wide,
      paramsLive,
      paramsIncoming,
    );
    expect(out).toBe(paramsLive);
  });

  test("empty params on both sides — params still returned on match", () => {
    const paramsLive = p("");
    const paramsIncoming = p("");
    const out = deriveActiveParams(
      PATH.DASHBOARD,
      PATH.DASHBOARD,
      ScreenType.Narrow,
      paramsLive,
      paramsIncoming,
    );
    expect(out).toBe(paramsLive);
  });
});
