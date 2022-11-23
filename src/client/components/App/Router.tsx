import { lazy, useState, useEffect, useMemo } from "react";
import { useAppContext } from "client";

const LoginPage = lazy(() => import("client/pages/LoginPage"));
const BudgetsPage = lazy(() => import("client/pages/BudgetsPage"));
const AccountsPage = lazy(() => import("client/pages/AccountsPage"));
const TransactionsPage = lazy(() => import("client/pages/TransactionsPage"));

const Router = () => {
  const [storedPath, setStoredPath] = useState(window.location.pathname);
  const { router } = useAppContext();
  const { path } = router;

  const transitioning = storedPath !== path;

  useEffect(() => {
    if (transitioning)
      setTimeout(() => {
        window.scrollTo(0, 0);
        setStoredPath(path);
      }, 300);
  }, [transitioning, setStoredPath, path]);

  const classNames = ["Router"];
  if (transitioning) classNames.push("transitioning");

  const getPage = (path: string) => {
    if (path === "/login") return <LoginPage />;
    if (path === "/accounts") return <AccountsPage />;
    if (path === "/transactions") return <TransactionsPage />;
    return <BudgetsPage />;
  };

  const currentPage = useMemo(() => getPage(storedPath), [storedPath]);
  const nextPage = useMemo(() => getPage(path), [path]);

  return (
    <div className={classNames.join(" ")}>
      <div className="currentPage">{currentPage}</div>
      <div className="nextPage">{transitioning && nextPage}</div>
    </div>
  );
};

export default Router;
