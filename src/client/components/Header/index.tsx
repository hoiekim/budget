import { MouseEventHandler, ReactNode } from "react";
import { useAppContext, PATH } from "client";
import { Interval } from "common";
import "./index.css";

const { innerHeight, innerWidth } = window;
const navigatorsHeight = innerHeight / innerWidth > 2 ? 80 : 60;

export const Header = () => {
  const { user, router, viewDate, setViewDate } = useAppContext();

  const { path, params, go, back } = router;

  type NavigatorProps = { target: PATH; children: ReactNode };
  const Navigator = ({ target, children }: NavigatorProps) => {
    const seleted = path === target && !params.values().next().value;
    return (
      <a
        className={seleted ? "selected" : undefined}
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

  const { BUDGETS, ACCOUNTS, TRANSACTIONS } = PATH;

  const isBackButtonDisabled =
    !params.toString() && !![BUDGETS, ACCOUNTS, TRANSACTIONS].includes(path);

  const onClickHamburger: MouseEventHandler<HTMLAnchorElement> = (e) => {
    e.preventDefault();
    if ([PATH.CONFIG, PATH.CONNECTION_DETAIL].includes(path)) back();
    else go(PATH.CONFIG);
  };

  return (
    <div className="Header" style={{ display: user ? undefined : "none" }}>
      <div className="viewController">
        <div className="centerBox">
          <div className="backButton">
            {!isBackButtonDisabled && <button onClick={onClickBack}>←</button>}
          </div>
          <div>
            <button onClick={onClickPreviousView}>
              <b>&nbsp;〈&nbsp;&nbsp;</b>
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
              <b>&nbsp;&nbsp;〉&nbsp;</b>
            </button>
          </div>
          <div className="hamburger">
            <a href={PATH.CONFIG} onClick={onClickHamburger}>
              ≡
            </a>
          </div>
        </div>
      </div>
      <div className="navigators" style={{ height: navigatorsHeight }}>
        <div className="centerBox">
          <Navigator target={BUDGETS}>Budget</Navigator>
          <Navigator target={ACCOUNTS}>Accounts</Navigator>
          <Navigator target={TRANSACTIONS}>Transactions</Navigator>
        </div>
      </div>
    </div>
  );
};
