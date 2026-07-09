import { MouseEventHandler, ReactNode, useState } from "react";
import { useAppContext, PATH, ScreenType } from "client";
import {
  ArrowLeftIcon,
  BankIcon,
  ChartIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DatePickerModal,
  HamburgerIcon,
  ListIcon,
  RecieptIcon,
} from "client/components";
import "./index.css";

export const Header = () => {
  const { user, router, viewDate, setViewDate, screenType } = useAppContext();

  const { path, params, go, back } = router;

  const onClickBack: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    back();
  };

  const {
    DASHBOARD,
    CHART_DETAIL,
    CHART_ACCOUNTS,
    BUDGETS,
    BUDGET_DETAIL,
    BUDGET_CONFIG,
    ACCOUNTS,
    ACCOUNT_DETAIL,
    TRANSACTIONS,
    TRANSACTION_DETAIL,
  } = PATH;

  const isBackButtonDisabled =
    !params.toString() && [DASHBOARD, BUDGETS, ACCOUNTS, TRANSACTIONS].includes(path);

  const onClickHamburger: MouseEventHandler<HTMLAnchorElement> = (e) => {
    e.preventDefault();
    if ([PATH.CONFIG, PATH.CONNECTION_DETAIL].includes(path)) back();
    else go(PATH.CONFIG);
  };
  const { innerHeight, innerWidth } = window;
  const navigatorsHeight =
    screenType !== ScreenType.Narrow ? "100%" : innerHeight / innerWidth > 2 ? 80 : 60;

  const classNames = ["Header"];
  if (screenType !== ScreenType.Narrow) classNames.push("wideScreen");

  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const interval = viewDate.getInterval();
  const datePickerLabel = viewDate.toString(
    interval === "year" ? undefined : { year: "numeric", month: "long" },
  );

  const onPrev = () => setViewDate((v) => v.clone().previous());
  const onNext = () => setViewDate((v) => v.clone().next());

  return (
    <div className={classNames.join(" ")} style={{ display: user ? undefined : "none" }}>
      <div className="viewController">
        <div className="centerBox">
          <div className="backButton">
            {!isBackButtonDisabled && (
              <button onClick={onClickBack}>
                <ArrowLeftIcon size={15} />
              </button>
            )}
          </div>
          <div className="datePicker">
            <button className="stepper" onClick={onPrev} aria-label="Previous period">
              <ChevronLeftIcon size={14} />
            </button>
            <button
              className="datePickerTrigger"
              onClick={() => setDatePickerOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={datePickerOpen}
            >
              {datePickerLabel}
            </button>
            <button className="stepper" onClick={onNext} aria-label="Next period">
              <ChevronRightIcon size={14} />
            </button>
          </div>
          <div className="hamburger">
            <a href={PATH.CONFIG} onClick={onClickHamburger}>
              <HamburgerIcon size={20} />
            </a>
          </div>
        </div>
      </div>
      {datePickerOpen && <DatePickerModal onClose={() => setDatePickerOpen(false)} />}
      <div className="navigators" style={{ height: navigatorsHeight }}>
        <div className="centerBox">
          <Navigator target={DASHBOARD} subPages={[CHART_DETAIL, CHART_ACCOUNTS]}>
            <ChartIcon size={20} />
            <span>Dashboard</span>
          </Navigator>
          <Navigator target={BUDGETS} subPages={[BUDGET_DETAIL, BUDGET_CONFIG]}>
            <ListIcon size={20} />
            <span>Budgets</span>
          </Navigator>
          <Navigator target={ACCOUNTS} subPages={[ACCOUNT_DETAIL]}>
            <BankIcon size={20} />
            <span>Accounts</span>
          </Navigator>
          {screenType === ScreenType.Narrow && (
            <TransactionsNavigator target={TRANSACTIONS} subPages={[TRANSACTION_DETAIL]}>
              <RecieptIcon size={20} />
              <span>Transactions</span>
            </TransactionsNavigator>
          )}
        </div>
      </div>
    </div>
  );
};

interface NavigatorProps {
  target: PATH;
  subPages?: PATH[];
  children: ReactNode;
}

const Navigator = ({ target, subPages = [], children }: NavigatorProps) => {
  const { router } = useAppContext();
  const { path, go } = router;
  const classNames = ["navigator"];
  const seleted = [...subPages, target].includes(path);
  if (seleted) classNames.push("selected");
  return (
    <a
      className={classNames.join(" ")}
      href={target}
      onClick={(e) => {
        e.preventDefault();
        go(target, { animate: false });
      }}
    >
      {children}
    </a>
  );
};

const TransactionsNavigator = ({ children }: NavigatorProps) => {
  const { router } = useAppContext();
  const { path, params, go } = router;
  const classNames = ["navigator"];
  const { TRANSACTIONS, TRANSACTION_DETAIL } = PATH;
  const seleted = [TRANSACTION_DETAIL, TRANSACTIONS].includes(path);
  if (seleted) classNames.push("selected");
  const onClickLink: MouseEventHandler<HTMLAnchorElement> = (e) => {
    e.preventDefault();
    if (path === TRANSACTIONS) {
      go(TRANSACTIONS, { animate: false });
    } else {
      go(TRANSACTIONS, { params, animate: false });
    }
  };
  return (
    <a className={classNames.join(" ")} href={TRANSACTIONS} onClick={onClickLink}>
      {children}
    </a>
  );
};
