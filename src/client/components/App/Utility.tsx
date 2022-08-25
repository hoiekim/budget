import { useEffect } from "react";
import { useAppContext, useSync } from "client";

let lastSync = new Date();

const Utility = () => {
  const { user, router } = useAppContext();
  const { path, go } = router;

  useEffect(() => {
    if (!user && path !== "/login") go("/login");
  }, [user, go, path]);

  const { sync, clean } = useSync();

  const userLoggedIn = !!user;

  useEffect(() => {
    if (userLoggedIn) sync.all();
    else clean();
  }, [userLoggedIn, sync, clean]);

  useEffect(() => {
    const focusAction = (event: FocusEvent) => {
      const now = new Date();
      if (now.getTime() - lastSync.getTime() > 1000 * 60) {
        sync.all();
        lastSync = now;
      }
    };
    window.addEventListener("focus", focusAction);
    return () => window.removeEventListener("focus", focusAction);
  }, []);

  return <></>;
};

export default Utility;
