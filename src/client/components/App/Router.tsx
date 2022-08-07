import { lazy, useMemo } from "react";
import { useAppContext } from "client";

const Home = lazy(() => import("client/pages/Home"));
const Login = lazy(() => import("client/pages/Login"));

const Router = () => {
  const { router } = useAppContext();
  const { path } = router;

  return useMemo(() => {
    if (path === "/login") {
      return <Login />;
    }
    return <Home />;
  }, [path]);
};

export default Router;
