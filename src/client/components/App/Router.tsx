import { lazy, useMemo } from "react";
import { useAppContext } from "client";

const Home = lazy(() => import("client/pages/Home"));
const Login = lazy(() => import("client/pages/Login"));
const Status = lazy(() => import("client/pages/Status"));

const Router = () => {
  const { router } = useAppContext();
  const { path } = router;

  return useMemo(() => {
    if (path === "/login") return <Login />;
    if (path === "/status") return <Status />;
    return <Home />;
  }, [path]);
};

export default Router;
