import { useState, useEffect, useRef, useCallback } from "react";

export type TransitionDirection = "forward" | "backward";

export enum PATH {
  LOGIN = "login",
  BUDGET = "budget",
  ACCOUNTS = "accounts",
  TRANSACTIONS = "transactions",
}

export interface ClientRouter {
  path: PATH;
  transition: {
    incomingPath: PATH;
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

const DEFAULT_TRANSITION_DURATION = 300;

let isRouterRegistered = false;

const getPath = () => {
  const path = window.location.pathname.split("/")[1];
  return Object.values(PATH).find((e) => e === path) || PATH.BUDGET;
};

export const useRouter = (): ClientRouter => {
  const [path, setPath] = useState(getPath());
  const [incomingPath, setIncomingPath] = useState(getPath());
  const [direction, setDirection] = useState<TransitionDirection>("forward");

  const isAnimationEnabled = useRef(true);

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const transition = useCallback((newPath: PATH) => {
    setIncomingPath(newPath);
    if (isAnimationEnabled.current) {
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => {
        window.scrollTo(0, 0);
        setPath(newPath);
      }, DEFAULT_TRANSITION_DURATION);
    } else {
      window.scrollTo(0, 0);
      setPath(newPath);
    }
  }, []);

  useEffect(() => {
    if (!isRouterRegistered) {
      const listner = () => transition(getPath());
      window.addEventListener("popstate", listner, false);
      isRouterRegistered = true;
    }
  }, [transition]);

  const go = useCallback(
    (target: PATH, options?: GoOptions) => {
      const { params, animate = true } = options || {};
      if (window.location.pathname !== target) {
        isAnimationEnabled.current = animate;
        setDirection("forward");
        const paramString = params?.toString();
        const path = "/" + target + (paramString ? "?" + paramString : "");
        window.history.pushState("", "", path);
        transition(target);
      }
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
    transition: {
      incomingPath,
      transitioning: incomingPath !== path,
      direction: incomingPath !== path ? direction : undefined,
    },
    go,
    forward,
    back,
  };
};
