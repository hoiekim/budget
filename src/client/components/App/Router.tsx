import { useMemo } from "react";
import {
  useAppContext,
  LoginPage,
  BudgetsPage,
  BudgetDetailPage,
  BudgetConfigPage,
  AccountsPage,
  TransactionsPage,
  TransactionDetailPage,
  ConfigPage,
  PATH,
  DashboardPage,
} from "client";
import ConnectionDetailPage from "client/pages/ConnectionDetailPage";

const Router = () => {
  const { router } = useAppContext();
  const { path, transition } = router;
  const { incomingPath, transitioning, direction } = transition;

  const classNames = ["Router"];
  if (transitioning && direction) classNames.push("transitioning", direction);

  const getPage = (path: string) => {
    if (path === PATH.LOGIN) return <LoginPage />;
    if (path === PATH.BUDGETS) return <BudgetsPage />;
    if (path === PATH.BUDGET_DETAIL) return <BudgetDetailPage />;
    if (path === PATH.BUDGET_CONFIG) return <BudgetConfigPage />;
    if (path === PATH.ACCOUNTS) return <AccountsPage />;
    if (path === PATH.TRANSACTIONS) return <TransactionsPage />;
    if (path === PATH.TRANSACTION_DETAIL) return <TransactionDetailPage />;
    if (path === PATH.CONFIG) return <ConfigPage />;
    if (path === PATH.CONNECTION_DETAIL) return <ConnectionDetailPage />;
    if (path === PATH.DASHBOARD) return <DashboardPage />;
    return <div>Not Found</div>;
  };

  const currentPage = useMemo(() => getPage(path), [path]);
  const incomingPage = useMemo(() => getPage(incomingPath), [incomingPath]);

  return (
    <div className={classNames.join(" ")}>
      <div className="previousPage">
        {transitioning && direction === "backward" && incomingPage}
      </div>
      <div className="currentPage">{currentPage}</div>
      <div className="nextPage">{transitioning && direction === "forward" && incomingPage}</div>
    </div>
  );
};

export default Router;
