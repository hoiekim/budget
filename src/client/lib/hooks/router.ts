import { useState, useEffect, useRef, useCallback } from "react";

export type TransitionDirection = "forward" | "backward";

export enum PATH {
  LOGIN = "login",
  BUDGET = "budget",
  ACCOUNTS = "accounts",
  TRANSACTIONS = "transactions",
}

export interface ClientRouter {
  path: string;
  incomingPath: string;
  transition: {
    isTransitioning: boolean;
    direction?: TransitionDirection;
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

const landingPath = window.location.pathname.split("/")[1];

export const useRouter = (): ClientRouter => {
  const [path, setPath] = useState(landingPath);
  const [incomingPath, setIncomingPath] = useState(landingPath);
  const [direction, setDirection] = useState<TransitionDirection>("forward");

  const isAnimationEnabled = useRef(true);

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const transition = useCallback((newPath: string) => {
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
      const listner = () => transition(window.location.pathname.split("/")[1]);
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
    incomingPath,
    transition: {
      isTransitioning: incomingPath !== path,
      direction: incomingPath !== path ? direction : undefined,
    },
    go,
    forward,
    back,
  };
};
