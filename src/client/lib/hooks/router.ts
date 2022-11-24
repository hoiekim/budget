import { useState, useEffect, useRef, useCallback } from "react";

type TransitionDirection = "forward" | "backward";

export interface ClientRouter {
  path: string;
  incomingPath: string;
  transition: {
    isTransitioning: boolean;
    direction?: TransitionDirection;
  };
  go: (path: string, delayedTransition?: boolean) => void;
  forward: (delayedTransition?: boolean) => void;
  back: (delayedTransition?: boolean) => void;
}

const DEFAULT_TRANSITION_DURATION = 300;

let isRouterRegistered = false;

export const useRouter = (): ClientRouter => {
  const [path, setPath] = useState(window.location.pathname);
  const [incomingPath, setIncomingPath] = useState(window.location.pathname);
  const [direction, setDirection] = useState<TransitionDirection>("forward");

  const isDelayedTransitionEnabled = useRef(true);

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const transition = useCallback(
    (newPath: string) => {
      setIncomingPath(newPath);
      if (isDelayedTransitionEnabled.current) {
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => {
          window.scrollTo(0, 0);
          setPath(newPath);
        }, DEFAULT_TRANSITION_DURATION);
      } else {
        setPath(newPath);
      }
    },
    [setIncomingPath, setPath]
  );

  useEffect(() => {
    if (!isRouterRegistered) {
      window.addEventListener(
        "popstate",
        () => transition(window.location.pathname),
        false
      );
      isRouterRegistered = true;
    }
  }, [transition]);

  const go = useCallback(
    (target: string, delayedTransition = true) => {
      if (window.location.pathname !== target) {
        isDelayedTransitionEnabled.current = delayedTransition;
        setDirection("forward");
        window.history.pushState("", "", target);
        transition(target);
      }
    },
    [transition]
  );

  const forward = useCallback((delayedTransition = true) => {
    isDelayedTransitionEnabled.current = delayedTransition;
    setDirection("forward");
    window.history.forward();
  }, []);

  const back = useCallback((delayedTransition = true) => {
    isDelayedTransitionEnabled.current = delayedTransition;
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
