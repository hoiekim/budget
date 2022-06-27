import { useAppContext } from "client";
import { Home, Login } from "client/pages";

const Router = () => {
  const { router } = useAppContext();
  const { path } = router;

  if (path === "/login") {
    return <Login />;
  }
  return <Home />;
};

export default Router;
