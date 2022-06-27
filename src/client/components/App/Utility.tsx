import { useEffect } from "react";
import { useAppContext, useSync } from "client";

const Utility = () => {
  const { user, router } = useAppContext();
  const { path, go } = router;

  useEffect(() => {
    if (!user && path !== "/login") go("/login");
  }, [user, go, path]);

  const { sync, clean } = useSync();

  useEffect(() => {
    if (user) sync();
    else clean();
  }, [user, sync, clean]);

  return <></>;
};

export default Utility;
