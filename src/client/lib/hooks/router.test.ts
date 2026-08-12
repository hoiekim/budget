import { describe, test, expect } from "bun:test";
import { deriveActiveParams, getParentPath, isPageTreeStep, PATH } from "./router";
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

/**
 * Which navigations leave a history entry behind. This is what decides
 * whether the header's back button walks pages or walks every period the
 * user stepped through on one page (#699).
 */
describe("isPageTreeStep", () => {
  test("a different page is always a step", () => {
    expect(isPageTreeStep(PATH.ACCOUNTS, p(""), PATH.ACCOUNT_DETAIL, p("account_id=a"))).toBe(
      true,
    );
  });

  test("stepping the period on one page is not a step", () => {
    // The reported bug: `useViewDate`'s writer navigates same-path on
    // every prev/next/pick, so each one used to push an entry and back
    // rewound the date instead of leaving the page.
    expect(
      isPageTreeStep(PATH.DASHBOARD, p("view_date=2026-08"), PATH.DASHBOARD, p("view_date=2026-07")),
    ).toBe(false);
  });

  test("adding or removing the period param is not a step either", () => {
    // `resetViewDate` (the picker's Current button) DELETES the param, and
    // the first date pick ADDS it. Comparing only the keys present on one
    // side would miss both, and each would push an entry again.
    expect(isPageTreeStep(PATH.DASHBOARD, p("view_date=2026-08"), PATH.DASHBOARD, p(""))).toBe(
      false,
    );
    expect(isPageTreeStep(PATH.DASHBOARD, p(""), PATH.DASHBOARD, p("view_date=2026-08"))).toBe(
      false,
    );
  });

  test("toggling the transactions filter chips is not a step", () => {
    expect(
      isPageTreeStep(
        PATH.TRANSACTIONS,
        p("transactions_type=expenses"),
        PATH.TRANSACTIONS,
        p("transactions_type=expenses,deposits"),
      ),
    ).toBe(false);
  });

  test("switching which entity the page shows IS a step", () => {
    // Same path, but a different account's detail page is a different
    // page in the tree — back has to return to the first one.
    expect(
      isPageTreeStep(
        PATH.ACCOUNT_DETAIL,
        p("account_id=a"),
        PATH.ACCOUNT_DETAIL,
        p("account_id=b"),
      ),
    ).toBe(true);
  });

  test("a navigational param changing alongside the period is a step", () => {
    // `go()` copies `view_date` into every cross-page navigation, so the
    // two kinds of param routinely change together. The non-navigational
    // one must not mask the other.
    expect(
      isPageTreeStep(
        PATH.ACCOUNT_DETAIL,
        p("account_id=a&view_date=2026-08"),
        PATH.ACCOUNT_DETAIL,
        p("account_id=b&view_date=2026-07"),
      ),
    ).toBe(true);
  });

  test("a navigational param appearing on only one side is a step", () => {
    // Comparing just the keys the CURRENT url has would read an added
    // param as "no key changed" and replace the entry, so back would skip
    // straight past the unfiltered page the user came from. The mirror
    // case (dropping the param) has the same hole.
    expect(isPageTreeStep(PATH.TRANSACTIONS, p(""), PATH.TRANSACTIONS, p("budget_id=b"))).toBe(
      true,
    );
    expect(isPageTreeStep(PATH.TRANSACTIONS, p("budget_id=b"), PATH.TRANSACTIONS, p(""))).toBe(
      true,
    );
  });

  test("navigating to the identical route is not a step", () => {
    expect(
      isPageTreeStep(PATH.BUDGETS, p("view_date=2026-08"), PATH.BUDGETS, p("view_date=2026-08")),
    ).toBe(false);
  });
});

/**
 * The fallback used when there is no session history to walk — a reload or
 * a shared link that opens straight onto a detail page.
 */
describe("getParentPath", () => {
  test("a detail page climbs to its section root", () => {
    expect(getParentPath(PATH.ACCOUNT_DETAIL)).toBe(PATH.ACCOUNTS);
    expect(getParentPath(PATH.HOLDING_DETAIL)).toBe(PATH.ACCOUNTS);
    expect(getParentPath(PATH.BUDGET_DETAIL)).toBe(PATH.BUDGETS);
    expect(getParentPath(PATH.BUDGET_CONFIG)).toBe(PATH.BUDGETS);
    expect(getParentPath(PATH.TRANSACTION_DETAIL)).toBe(PATH.TRANSACTIONS);
    expect(getParentPath(PATH.CHART_DETAIL)).toBe(PATH.DASHBOARD);
    expect(getParentPath(PATH.CHART_ACCOUNTS)).toBe(PATH.DASHBOARD);
  });

  test("the config subtree climbs to config — it has no navigator entry", () => {
    expect(getParentPath(PATH.CONNECTION_DETAIL)).toBe(PATH.CONFIG);
    expect(getParentPath(PATH.API_KEY_DETAIL)).toBe(PATH.CONFIG);
  });

  test("a section root has no parent — this is where back stops", () => {
    // Drives `canGoBack`, so a root opened directly renders no back
    // button at all rather than one that hands the user to the previous
    // website.
    expect(getParentPath(PATH.DASHBOARD)).toBeUndefined();
    expect(getParentPath(PATH.BUDGETS)).toBeUndefined();
    expect(getParentPath(PATH.ACCOUNTS)).toBeUndefined();
    expect(getParentPath(PATH.TRANSACTIONS)).toBeUndefined();
    expect(getParentPath(PATH.CONFIG)).toBeUndefined();
  });
});
