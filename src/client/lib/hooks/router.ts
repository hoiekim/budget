import { useState, useEffect, useRef, useCallback } from "react";
import { Timeout } from "common";

export type TransitionDirection = "forward" | "backward";

export enum PATH {
  LOGIN = "login",
  BUDGETS = "budgets",
  BUDGET_DETAIL = "budget-detail",
  BUDGET_CONFIG = "budget-config",
  ACCOUNTS = "accounts",
  TRANSACTIONS = "transactions",
  TRANSACTION_DETAIL = "transaction-detail",
  CONFIG = "config",
  CONNECTION_DETAIL = "connection-detail",
  DASHBOARD = "dashboard",
  CHART_DETAIL = "chart-detail",
  CHART_ACCOUNTS = "chart-accounts",
}

export interface ClientRouter {
  path: PATH;
  params: URLSearchParams;
  transition: {
    incomingPath: PATH;
    incomingParams: URLSearchParams;
    transitioning: boolean;
    direction: TransitionDirection | undefined;
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

const getPath = () => {
  const path = window.location.pathname.split("/")[1];
  return Object.values(PATH).find((e) => e === path) || PATH.DASHBOARD;
};

const getParams = () => {
  return new URLSearchParams(window.location.search);
};

const getURLString = (path: PATH, params?: URLSearchParams) => {
  const paramString = params?.toString();
  return "/" + path + (paramString ? "?" + paramString : "");
};

export const useRouter = (): ClientRouter => {
  const [path, setPath] = useState(getPath());
  const [incomingPath, setIncomingPath] = useState(getPath());
  const [params, setParams] = useState(getParams());
  const [incomingParams, setIncomingParams] = useState(getParams());
  const [direction, setDirection] = useState<TransitionDirection>("forward");

  const isAnimationEnabled = useRef(false);

  const timeout = useRef<Timeout>();

  const transition = useCallback((newPath: PATH, newParams: URLSearchParams) => {
    setIncomingPath(newPath);
    setIncomingParams(newParams);

    const endTransition = () => {
      window.scrollTo(0, 0);
      setPath(newPath);
      setParams(newParams);
      isAnimationEnabled.current = false;
    };

    if (window.innerWidth < 950 && isAnimationEnabled.current) {
      clearTimeout(timeout.current);
      timeout.current = setTimeout(endTransition, DEFAULT_TRANSITION_DURATION);
    } else {
      endTransition();
    }
  }, []);

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
    [transition]
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
    },
    go,
    forward,
    back,
  };
};
