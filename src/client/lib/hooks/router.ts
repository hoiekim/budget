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

  const timeout = useRef<Timeout>();

  const transition = useCallback(
    (newPath: PATH, newParams: URLSearchParams) => {
      // Snapshot OUTGOING scroll position from window.location BEFORE
      // pushState mutates it (caller invokes pushState after transition
      // returns). The current URL is still the outgoing one here.
      const outgoingPath = getPath();
      const outgoingParams = getParams();
      const outgoingScrollY = window.scrollY;
      scrollMemory.set(getScrollKey(outgoingPath, outgoingParams), outgoingScrollY);

      // Set the slide-anchor offset: during the horizontal slide, both
      // pages share the same vertical position so the user doesn't see
      // a jump-to-top jolt before the slide-in completes.
      setSlideAnchorY(outgoingScrollY);

      setIncomingPath(newPath);
      setIncomingParams(newParams);

      const endTransition = () => {
        // Restore INCOMING scroll position (or 0 if never visited).
        // `requestAnimationFrame` so the new page's content has a
        // chance to commit to the DOM before we set scrollTop —
        // otherwise scrollTo silently no-ops on a short page.
        const restoredY = scrollMemory.get(getScrollKey(newPath, newParams)) ?? 0;
        setPath(newPath);
        setParams(newParams);
        requestAnimationFrame(() => {
          window.scrollTo(0, restoredY);
          setSlideAnchorY(0);
        });
        isAnimationEnabled.current = false;
      };

      if (window.innerWidth < 950 && isAnimationEnabled.current) {
        clearTimeout(timeout.current);
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
