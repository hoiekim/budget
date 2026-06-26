import { useState, useEffect, useRef, useCallback, Dispatch, SetStateAction } from "react";
import { Timeout } from "common";

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
  go: (path: PATH, options?: GoOptions) => void;
  forward: (options?: NavigateOptions) => void;
  back: (options?: NavigateOptions) => void;
}

export type GoOptions = NavigateOptions & {
  params?: URLSearchParams;
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

export const useRouter = (): ClientRouter => {
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

  const transition = useCallback(
    (newPath: PATH, newParams: URLSearchParams) => {
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

      // Set the slide-anchor offset: during the horizontal slide, both
      // pages share the same vertical position so the user doesn't see
      // a jump-to-top jolt before the slide-in completes.
      setSlideAnchorY(outgoingScrollY);

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
      const { params: newParams, animate = true } = options || {};
      isAnimationEnabled.current = animate;
      setDirection("forward");
      transition(target, newParams || new URLSearchParams());
      window.history.pushState("", "", getURLString(target, newParams));
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
    go,
    forward,
    back,
  };
};
