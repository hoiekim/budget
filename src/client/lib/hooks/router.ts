import { useState, useEffect, useCallback, Dispatch } from "react";

export interface ClientRouter {
  path: string;
  go: Dispatch<string>;
  forward: () => void;
  back: () => void;
}

let isRouterRegistered = false;

export const useRouter = (): ClientRouter => {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    if (!isRouterRegistered) {
      window.addEventListener("popstate", () => setPath(window.location.pathname), false);
      isRouterRegistered = true;
    }
  }, []);

  const go = useCallback((target: string) => {
    if (window.location.pathname !== target) {
      window.history.pushState("", "", target);
      setPath(target);
    }
  }, []);

  const forward = useCallback(() => window.history.forward(), []);

  const back = useCallback(() => window.history.back(), []);

  return { path, go, forward, back };
};
