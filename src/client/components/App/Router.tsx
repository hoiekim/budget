import { useMemo } from "react";
import { useAppContext, PATH, ScreenType } from "client";
import {
  LoginPage,
  BudgetsPage,
  BudgetDetailPage,
  BudgetConfigPage,
  AccountsPage,
  TransactionsPage,
  TransactionDetailPage,
  ConfigPage,
  DashboardPage,
  ChartDetailPage,
  ConnectionDetailPage,
  ChartAccountsPage,
  AccountDetailPage,
  HoldingDetailPage,
  SnapshotsPage,
  ApiKeyDetailPage,
} from "client/pages";
import { Spinner } from "./Spinner";

const getPage = (path: string) => {
  if (path === PATH.LOGIN) return <LoginPage />;
  if (path === PATH.BUDGETS) return <BudgetsPage />;
  if (path === PATH.BUDGET_DETAIL) return <BudgetDetailPage />;
  if (path === PATH.BUDGET_CONFIG) return <BudgetConfigPage />;
  if (path === PATH.ACCOUNTS) return <AccountsPage />;
  if (path === PATH.ACCOUNT_DETAIL) return <AccountDetailPage />;
  if (path === PATH.HOLDING_DETAIL) return <HoldingDetailPage />;
  if (path === PATH.SNAPSHOTS) return <SnapshotsPage />;
  if (path === PATH.TRANSACTIONS) return <TransactionsPage />;
  if (path === PATH.TRANSACTION_DETAIL) return <TransactionDetailPage />;
  if (path === PATH.CONFIG) return <ConfigPage />;
  if (path === PATH.CONNECTION_DETAIL) return <ConnectionDetailPage />;
  if (path === PATH.API_KEY_DETAIL) return <ApiKeyDetailPage />;
  if (path === PATH.DASHBOARD) return <DashboardPage />;
  if (path === PATH.CHART_DETAIL) return <ChartDetailPage />;
  if (path === PATH.CHART_ACCOUNTS) return <ChartAccountsPage />;
  return <div>Not Found</div>;
};

const Router = () => {
  const { user, router, status, screenType } = useAppContext();
  const { path, transition } = router;
  const { incomingPath, transitioning, direction, slideAnchorY } = transition;

  const classNames = ["Router"];
  if (transitioning && direction) classNames.push("transitioning", direction);

  const currentPage = useMemo(() => getPage(path), [path]);
  const incomingPage = useMemo(() => getPage(incomingPath), [incomingPath]);

  // During the horizontal slide animation, the previousPage / nextPage
  // panels are `position: fixed; top: 0`, so they default to showing
  // their content from y=0. `slideAnchorY` carries the INCOMING page's
  // OWN saved scroll position; shifting `top` by `-slideAnchorY`
  // anchors the sliding-in page at the exact scrollY it had when the
  // user last left it — so the slide previews the post-transition
  // restored state with no jump at swap time. The outgoing currentPage
  // is relative-positioned and ignores this style; after
  // `endTransition` restores the actual window scroll, `slideAnchorY`
  // resets to 0.
  const slidePanelStyle = transitioning ? { top: -slideAnchorY } : undefined;

  if (path === PATH.LOGIN) {
    return (
      <div className={classNames.join(" ")}>
        <div className="currentPage">{currentPage}</div>
      </div>
    );
  }

  if (!user) {
    return <></>;
  }

  if (screenType === ScreenType.Narrow) {
    return (
      <div className={classNames.join(" ")}>
        <div className="previousPage" style={slidePanelStyle}>
          {transitioning && direction === "backward" && incomingPage}
        </div>
        <div className="currentPage">{status.isInit ? currentPage : <Spinner />}</div>
        <div className="nextPage" style={slidePanelStyle}>
          {transitioning && direction === "forward" && incomingPage}
        </div>
      </div>
    );
  }

  classNames.push("wideScreen");

  return (
    <div className={classNames.join(" ")}>
      {status.isInit ? (
        <>
          <main>{currentPage}</main>
          {path !== PATH.TRANSACTIONS && (
            <aside>
              <TransactionsPage />
            </aside>
          )}
        </>
      ) : (
        <Spinner />
      )}
    </div>
  );
};

export default Router;
