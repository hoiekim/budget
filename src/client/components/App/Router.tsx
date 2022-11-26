import { useMemo } from "react";
import {
  useAppContext,
  LoginPage,
  BudgetsPage,
  AccountsPage,
  TransactionsPage,
  PATH,
} from "client";

const Router = () => {
  const { router } = useAppContext();
  const { path, incomingPath, transition } = router;
  const { isTransitioning, direction } = transition;

  const classNames = ["Router"];
  if (isTransitioning && direction) classNames.push("transitioning", direction);

  const getPage = (path: string) => {
    if (path === PATH.LOGIN) return <LoginPage />;
    if (path === PATH.BUDGET) return <BudgetsPage />;
    if (path === PATH.ACCOUNTS) return <AccountsPage />;
    if (path === PATH.TRANSACTIONS) return <TransactionsPage />;
    return <div>Not Found</div>;
  };

  const currentPage = useMemo(() => getPage(path), [path]);
  const incomingPage = useMemo(() => getPage(incomingPath), [incomingPath]);

  return (
    <div className={classNames.join(" ")}>
      <div className="previousPage">
        {isTransitioning && direction === "backward" && incomingPage}
      </div>
      <div className="currentPage">{currentPage}</div>
      <div className="nextPage">
        {isTransitioning && direction === "forward" && incomingPage}
      </div>
    </div>
  );
};

export default Router;
