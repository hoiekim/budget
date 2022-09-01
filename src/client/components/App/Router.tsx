import { lazy, useMemo } from "react";
import { useAppContext } from "client";

const LoginPage = lazy(() => import("client/pages/LoginPage"));
const HomePage = lazy(() => import("client/pages/HomePage"));
const BudgetsPage = lazy(() => import("client/pages/BudgetsPage"));
const AccountsPage = lazy(() => import("client/pages/AccountsPage"));
const TransactionsPage = lazy(() => import("client/pages/TransactionsPage"));

const Router = () => {
  const { router } = useAppContext();
  const { path } = router;

  return useMemo(() => {
    if (path === "/login") return <LoginPage />;
    if (path === "/budgets") return <BudgetsPage />;
    if (path === "/accounts") return <AccountsPage />;
    if (path === "/transactions") return <TransactionsPage />;
    return <HomePage />;
  }, [path]);
};

export default Router;
