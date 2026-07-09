import { useState, useEffect, useRef, useCallback, Dispatch, SetStateAction } from "react";
import { Timeout } from "common";
import { ScreenType } from "./context";

export type TransitionDirection = "forward" | "backward";

export enum PATH {
  LOGIN = "login",
  BUDGETS = "budgets",
  BUDGET_DETAIL = "budget-detail",
  BUDGET_CONFIG = "budget-config",
  ACCOUNTS = "accounts",
  ACCOUNT_DETAIL = "account-detail",
  HOLDING_DETAIL = "holding-detail",
  TRANSACTIONS = "transactions",
  TRANSACTION_DETAIL = "transaction-detail",
  CONFIG = "config",
  CONNECTION_DETAIL = "connection-detail",
  API_KEY_DETAIL = "api-key-detail",
  DASHBOARD = "dashboard",
  CHART_DETAIL = "chart-detail",
  CHART_ACCOUNTS = "chart-accounts",
}

/**
 * Pure helper backing `router.getActiveParams`. Extracted so it can be
 * unit-tested without mounting the router hook. See the docstring on
 * `getActiveParams` inside `useRouter` for the semantics + the foot-gun
 * on passing a sibling page's PATH.
 */
export const deriveActiveParams = (
  targetPath: PATH,
  currentPath: PATH,
  screenType: ScreenType,
  params: URLSearchParams,
  incomingParams: URLSearchParams,
): URLSearchParams => {
  if (currentPath === targetPath || screenType !== ScreenType.Narrow) return params;
  return incomingParams;
};

const getHighLevelPage = (path: string): PATH | undefined => {
  switch (path) {
    case PATH.BUDGETS:
    case PATH.BUDGET_DETAIL:
    case PATH.BUDGET_CONFIG:
      return PATH.BUDGETS;
    case PATH.ACCOUNTS:
    case PATH.ACCOUNT_DETAIL:
    case PATH.HOLDING_DETAIL:
      return PATH.ACCOUNTS;
    case PATH.TRANSACTIONS:
    case PATH.TRANSACTION_DETAIL:
      return PATH.TRANSACTIONS;
    case PATH.DASHBOARD:
    case PATH.CHART_DETAIL:
    case PATH.CHART_ACCOUNTS:
      return PATH.DASHBOARD;
  }
};

export interface ClientRouter {
  path: PATH;
  params: URLSearchParams;
  transition: {
    incomingPath: PATH;
    incomingParams: URLSearchParams;
    transitioning: boolean;
    direction: TransitionDirection | undefined;
    /**
     * Vertical offset applied to the slide-in / slide-out panels during
     * a forward/backward transition so both pages visually share the
     * outgoing scroll position. Snapshots `window.scrollY` at transition
     * start and resets to 0 when the new page's saved scroll is restored.
     */
    slideAnchorY: number;
  };
  getActiveParams: (targetPath: PATH) => URLSearchParams;
  go: (path: PATH, options?: GoOptions) => void;
  forward: (options?: NavigateOptions) => void;
  back: (options?: NavigateOptions) => void;
}

export type GoOptions = NavigateOptions & {
  params?: URLSearchParams;
  /**
   * `router.go()` copies `view_date` from the current URL into the new
   * params by default, so cross-page navigation stays anchored to the
   * period the user was viewing. Pass `preserveViewDate: false` to
   * bypass — needed for `useViewDate`'s `resetViewDate` (the modal's
   * Current button) which wants to REMOVE the param entirely, not have
   * it re-injected.
   */
  preserveViewDate?: boolean;
};

export interface NavigateOptions {
  animate?: boolean;
}

export const DEFAULT_TRANSITION_DURATION = 300;

let isRouterRegistered = false;

/**
 * Per-(path+params) scroll memory. Survives in-session navigation
 * (module-level Map, like `stateMemory` in `cache.ts`) but NOT page
 * reload. Key is the URL minus the leading slash, so each filter combo
 * has its own scroll position (e.g. `/transactions?budget_id=X` and
 * `/transactions?budget_id=Y` track independently).
 *
 * Reset to 0 if no entry is present, matching the historical behavior
 * of always-scroll-to-top.
 */
export const scrollMemory = new Map<string, number>();

export const getScrollKey = (path: PATH, params?: URLSearchParams): string => {
  const paramString = params?.toString();
  return path + (paramString ? "?" + paramString : "");
};

const getPath = () => {
  const locationPath = window.location.pathname.split("/")[1];
  const foundInLocation = Object.values(PATH).find((e) => e === locationPath);
  if (foundInLocation) return foundInLocation;
  const localStoragePath = window.localStorage.getItem("path") || "";
  const foundInLocalStorage = getHighLevelPage(localStoragePath);
  if (foundInLocalStorage) return foundInLocalStorage;
  return PATH.DASHBOARD;
};

const getParams = () => {
  return new URLSearchParams(window.location.search);
};

const getURLString = (path: PATH, params?: URLSearchParams) => {
  const paramString = params?.toString();
  return "/" + path + (paramString ? "?" + paramString : "");
};

export const useRouter = (screenType: ScreenType): ClientRouter => {
  const [path, _setPath] = useState<PATH>(getPath());
  const setPath: Dispatch<SetStateAction<PATH>> = useCallback(
    (value) => {
      _setPath((oldValue) => {
        const valueToStore = value instanceof Function ? value(oldValue) : value;
        window.localStorage.setItem("path", valueToStore);
        return valueToStore;
      });
    },
    [_setPath],
  );

  const [incomingPath, setIncomingPath] = useState(getPath());
  const [params, setParams] = useState(getParams());
  const [incomingParams, setIncomingParams] = useState(getParams());
  const [direction, setDirection] = useState<TransitionDirection>("forward");
  const [slideAnchorY, setSlideAnchorY] = useState(0);

  const isAnimationEnabled = useRef(false);

  // Mirror current path/params into refs so `transition()` can read the
  // OUTGOING route at the moment it's invoked. `getPath()`/`getParams()`
  // (which read window.location) are NOT safe here: the popstate
  // listener fires AFTER the browser has already updated the URL to the
  // back-target, so window.location at that point is the INCOMING route,
  // not the outgoing one. Using refs keyed off React state survives that.
  const currentPathRef = useRef(getPath());
  const currentParamsRef = useRef(getParams());

  const timeout = useRef<Timeout>();
  // Handle of the in-flight scroll-restore rAF loop, so a new
  // transition can cancel a stale loop before its terminal
  // setSlideAnchorY(0) / scrollTo fires mid-slide.
  const rafHandle = useRef<number>();

  // `skipScrollRestore` short-circuits the endTransition scroll-restore
  // rAF loop. Same-path navigation (a control changing query params on
  // the currently-mounted page) preserves the DOM — the caller usually
  // wants to control scroll itself (e.g. a section header wanting to
  // `scrollIntoView` on unfold). Without this, the router's terminal
  // `window.scrollTo(0, restoredY=0)` fires 16× across 250ms and
  // clobbers any scroll the caller set up.
  const transition = useCallback(
    (newPath: PATH, newParams: URLSearchParams, skipScrollRestore = false) => {
      // Supersede any in-flight transition tail before starting a new
      // one: cancel the pending animated endTransition AND the
      // scroll-restore rAF loop. Without this, a rapid re-navigation
      // leaves a stale loop running whose terminal setSlideAnchorY(0)
      // and window.scrollTo fire mid-slide of THIS transition —
      // collapsing its anchor (the jolt the feature prevents) and
      // fighting the new page's scroll.
      clearTimeout(timeout.current);
      if (rafHandle.current !== undefined) cancelAnimationFrame(rafHandle.current);

      // Snapshot OUTGOING scroll position keyed by the outgoing path —
      // read from the ref (not window.location), see comment above.
      const outgoingPath = currentPathRef.current;
      const outgoingParams = currentParamsRef.current;
      const outgoingScrollY = window.scrollY;
      scrollMemory.set(getScrollKey(outgoingPath, outgoingParams), outgoingScrollY);

      // Advance the current-route refs IMMEDIATELY, not in
      // endTransition. endTransition is cancelled by a rapid
      // re-navigation (clearTimeout above), so if the refs only
      // advanced there, the interrupting transition would read this
      // stale outgoing route and mis-key its own snapshot under it —
      // clobbering the previous page's real saved scrollY with the
      // mid-animation (often clamped-to-0) value.
      currentPathRef.current = newPath;
      currentParamsRef.current = newParams;

      // Set the slide-anchor offset to the INCOMING page's OWN saved
      // scroll position. The fixed-positioned previousPage / nextPage
      // panels default to showing content from y=0; shifting their
      // `top` by `-incomingSavedY` makes the sliding-in page render at
      // exactly the scroll position it had when the user last left it,
      // matching the post-transition restore — so there's no jump at
      // the moment the page swaps into normal flow. The outgoing
      // (currentPage) is relative-positioned and ignores this offset,
      // continuing to render at its in-progress scrollY.
      const incomingSavedY = scrollMemory.get(getScrollKey(newPath, newParams)) ?? 0;
      setSlideAnchorY(incomingSavedY);

      setIncomingPath(newPath);
      setIncomingParams(newParams);

      const endTransition = () => {
        // Restore INCOMING scroll position (or 0 if never visited).
        // The new page may need async data fetches + layout passes
        // before its content reaches the target scrollHeight, so a
        // single `requestAnimationFrame` is not enough — `scrollTo`
        // would clamp to the partial height. Retry across a few
        // frames until either the actual `scrollY` matches the
        // requested value OR ~250ms have elapsed, whichever comes
        // first. Bounded by a max-attempt count so a genuinely-short
        // page (where target Y is unreachable) doesn't loop forever.
        const restoredY = scrollMemory.get(getScrollKey(newPath, newParams)) ?? 0;
        setPath(newPath);
        setParams(newParams);

        if (skipScrollRestore) {
          isAnimationEnabled.current = false;
          return;
        }

        const startedAt = performance.now();
        let attempts = 0;
        const tryRestore = () => {
          window.scrollTo(0, restoredY);
          attempts++;
          const reached = Math.abs(window.scrollY - restoredY) < 1;
          const tooLong = performance.now() - startedAt > 250;
          if (reached || tooLong || attempts > 16) {
            rafHandle.current = undefined;
            setSlideAnchorY(0);
            return;
          }
          rafHandle.current = requestAnimationFrame(tryRestore);
        };
        rafHandle.current = requestAnimationFrame(tryRestore);

        isAnimationEnabled.current = false;
      };

      // Same-path (query-param-only) transitions never slide. Animation
      // is meaningful for a NEW view — a URL that swapped one filter for
      // another, or a browser-back stepping through the view_date
      // history on the current page, should not flash a 300ms slide
      // over otherwise-identical layout. Callers that navigate
      // explicitly (e.g. `useMultiSelectQueryFilter`'s writer) already
      // pass `animate: false` to `go()`, but browser-driven popstate
      // flips this on: `back()` defaults `isAnimationEnabled.current =
      // true`, and popstate can't know whether the target is same-path.
      // Detect it here instead — the refs advanced above hold the
      // outgoing route.
      const isSamePath = newPath === outgoingPath;
      if (isSamePath) {
        isAnimationEnabled.current = false;
      }

      if (window.innerWidth < 950 && isAnimationEnabled.current) {
        timeout.current = setTimeout(endTransition, DEFAULT_TRANSITION_DURATION);
      } else {
        endTransition();
      }
    },
    [setPath],
  );

  useEffect(() => {
    if (!isRouterRegistered) {
      const listner = () => {
        transition(getPath(), getParams());
      };
      window.addEventListener("popstate", listner, false);
      isRouterRegistered = true;
    }
  }, [transition]);

  const go = useCallback(
    (target: PATH, options?: GoOptions) => {
      const { params: providedParams, animate = true, preserveViewDate = true } = options || {};
      isAnimationEnabled.current = animate;
      setDirection("forward");

      // Preserve `view_date` across every cross-page navigation. Users
      // expect the period they're viewing to persist as they move
      // between pages — jumping from `/budgets?view_date=2026-05` to a
      // detail view or the accounts page should keep them anchored to
      // May 2026 rather than snapping back to the current month.
      //
      // Skip preservation when:
      // - Caller sets `preserveViewDate: false` — explicit opt-out for
      //   `resetViewDate` (the modal's Current button), which wants to
      //   REMOVE the param entirely, not have it re-injected.
      // - Caller supplies `view_date` in `options.params` — caller wins.
      // - Current URL has NO `view_date` (Current mode = implicit "now")
      //   — no injection, so bookmarks stay clean.
      const finalParams = new URLSearchParams(providedParams);
      if (preserveViewDate && !finalParams.has("view_date")) {
        const currentViewDate = currentParamsRef.current.get("view_date");
        if (currentViewDate) finalParams.set("view_date", currentViewDate);
      }

      // Same-path navigation (control changes query params on the
      // currently-mounted page) preserves DOM state. Let the caller
      // handle scroll — see the `skipScrollRestore` comment on
      // `transition` above.
      const skipScrollRestore = target === currentPathRef.current;
      transition(target, finalParams, skipScrollRestore);
      window.history.pushState("", "", getURLString(target, finalParams));
    },
    [transition],
  );

  const forward = useCallback((options?: NavigateOptions) => {
    const { animate = true } = options || {};
    isAnimationEnabled.current = animate;
    setDirection("forward");
    window.history.forward();
  }, []);

  const back = useCallback((options?: NavigateOptions) => {
    const { animate = true } = options || {};
    isAnimationEnabled.current = animate;
    setDirection("backward");
    window.history.back();
  }, []);

  /**
   * URL params source for a page or component that renders during a
   * narrow-screen route transition — while BOTH the outgoing and
   * incoming page share the DOM for the slide animation.
   *
   * `targetPath` must be the {@link PATH} the caller BELONGS to.
   * The state model during a narrow-screen animated transition (see
   * `transition()` above, which calls `setIncomingPath` / `setIncomingParams`
   * immediately but defers `setPath` / `setParams` inside `endTransition`
   * behind a `setTimeout(..., DEFAULT_TRANSITION_DURATION)`):
   *
   * - `path` still holds the OUTGOING route.
   * - `params` still holds the OUTGOING URL params.
   * - `incomingPath` holds the DESTINATION route.
   * - `incomingParams` holds the DESTINATION URL params.
   *
   * So for the OUTGOING caller, `path === targetPath` succeeds and this
   * returns `params` — the caller keeps rendering its own URL as it slides
   * out. For the INCOMING caller, `path === targetPath` fails (path still
   * holds the outgoing route), and this returns `incomingParams` — the
   * caller reads its destination URL before the delayed `setParams` fires
   * ~300ms later, avoiding a flash-empty title / filter / detail lookup
   * on the first paint.
   *
   * Wide-screen viewports skip the animation entirely (`endTransition`
   * runs synchronously), so the `screenType !== Narrow` guard returns
   * `params` unconditionally — reads and writes stay in sync.
   *
   * Passing the wrong `PATH` (a sibling page's identity) silently keeps
   * the caller reading `incomingParams` at steady-state under narrow,
   * which reads as "the filter dropdown never updates from the URL" —
   * verify the arg matches the enclosing route.
   */
  const getActiveParams = useCallback(
    (targetPath: PATH) => deriveActiveParams(targetPath, path, screenType, params, incomingParams),
    [path, screenType, params, incomingParams],
  );

  return {
    path,
    params,
    transition: {
      incomingPath,
      incomingParams,
      transitioning: incomingPath !== path,
      direction: incomingPath !== path ? direction : undefined,
      slideAnchorY,
    },
    getActiveParams,
    go,
    forward,
    back,
  };
};
