import { useMemo } from "react";
import {
  useAppContext,
  LoginPage,
  BudgetsPage,
  AccountsPage,
  TransactionsPage,
} from "client";

const Router = () => {
  const { router } = useAppContext();
  const { path, incomingPath, transition } = router;
  const { isTransitioning, direction } = transition;

  const classNames = ["Router"];
  if (isTransitioning && direction) classNames.push("transitioning", direction);

  const getPage = (path: string) => {
    if (path === "/login") return <LoginPage />;
    if (path === "/accounts") return <AccountsPage />;
    if (path === "/transactions") return <TransactionsPage />;
    return <BudgetsPage />;
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
