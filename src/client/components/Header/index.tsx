import { MouseEventHandler, ReactNode } from "react";
import { useAppContext, PATH, ScreenType } from "client";
import {
  ArrowLeftIcon,
  BankIcon,
  ChartIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  HamburgerIcon,
  ListIcon,
  RecieptIcon,
} from "client/components";
import { Interval } from "common";
import "./index.css";

export const Header = () => {
  const { user, router, viewDate, setViewDate, screenType } = useAppContext();

  const { path, params, go, back } = router;

  type NavigatorProps = { target: PATH; children: ReactNode };
  const Navigator = ({ target, children }: NavigatorProps) => {
    const classNames = ["navigator"];
    const seleted = path === target && !params.values().next().value;
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

  const onClickPreviousView = () => {
    setViewDate((oldViewDate) => {
      const newViewDate = oldViewDate.clone().previous();
      return newViewDate;
    });
  };

  const onClickNextView = () => {
    setViewDate((oldViewDate) => {
      const newViewDate = oldViewDate.clone().next();
      return newViewDate;
    });
  };

  const getIntervalOptionText = (interval: Interval, fallback: string) => {
    if (viewDate.getInterval() !== interval) return fallback;
    return viewDate.toString();
  };

  const onClickBack: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    back();
  };

  const { DASHBOARD, BUDGETS, ACCOUNTS, TRANSACTIONS } = PATH;

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
          <div>
            <button onClick={onClickPreviousView}>
              <ChevronLeftIcon size={12} />
            </button>
            <select
              className="intervalSelect"
              value={viewDate.getInterval()}
              onChange={(e) => {
                const value = e.target.value as Interval;
                setViewDate((oldViewDate) => {
                  const newViewDate = oldViewDate.clone();
                  newViewDate.setInterval(value);
                  return newViewDate;
                });
              }}
            >
              <option value="year">{getIntervalOptionText("year", "Yearly")}</option>
              <option value="month">{getIntervalOptionText("month", "Monthly")}</option>
            </select>
            <button onClick={onClickNextView}>
              <ChevronRightIcon size={12} />
            </button>
          </div>
          <div className="hamburger">
            <a href={PATH.CONFIG} onClick={onClickHamburger}>
              <HamburgerIcon size={20} />
            </a>
          </div>
        </div>
      </div>
      <div className="navigators" style={{ height: navigatorsHeight }}>
        <div className="centerBox">
          <Navigator target={DASHBOARD}>
            <ChartIcon size={20} />
            <span>Dashboard</span>
          </Navigator>
          <Navigator target={BUDGETS}>
            <ListIcon size={20} />
            <span>Budgets</span>
          </Navigator>
          <Navigator target={ACCOUNTS}>
            <BankIcon size={20} />
            <span>Accounts</span>
          </Navigator>
          {screenType === ScreenType.Narrow && (
            <Navigator target={TRANSACTIONS}>
              <RecieptIcon size={20} />
              <span>Transactions</span>
            </Navigator>
          )}
        </div>
      </div>
    </div>
  );
};
