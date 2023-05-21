import { MouseEventHandler, ReactNode, useState } from "react";
import { useAppContext, useSync, call, PATH } from "client";
import { Interval } from "common";
import "./index.css";

const { innerHeight, innerWidth } = window;
const navigatorsHeight = innerHeight / innerWidth > 2 ? 80 : 60;

const Header = () => {
  const { user, setUser, router, viewDate, setViewDate } = useAppContext();

  const [isHamburgerOpen, setIsHamburgerOpen] = useState(false);

  const { clean } = useSync();
  const { path, params, go, back } = router;

  const logout = () => {
    call.delete("/api/login").then((r) => {
      setUser(undefined);
      setIsHamburgerOpen(false);
      clean();
    });
  };

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

  return (
    <div className="Header" style={{ display: user ? undefined : "none" }}>
      <div className="viewController">
        <div className="centerBox">
          <div className="backButton">
            <button onClick={onClickBack} disabled={isBackButtonDisabled}>
              {isBackButtonDisabled ? "" : "←"}
            </button>
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
              <option value="week">{getIntervalOptionText("week", "Weekly")}</option>
              <option value="day">{getIntervalOptionText("day", "Daily")}</option>
            </select>
            <button onClick={onClickNextView}>
              <b>&nbsp;&nbsp;〉&nbsp;</b>
            </button>
          </div>
          <div className="hamburger">
            <button onClick={() => setIsHamburgerOpen((s) => !s)}>≡</button>
            {isHamburgerOpen && (
              <>
                <div className="fadeCover" onClick={() => setIsHamburgerOpen(false)} />
                <div className="menu" onMouseLeave={() => setIsHamburgerOpen(false)}>
                  <button disabled={!user} onClick={logout}>
                    Logout
                  </button>
                </div>
              </>
            )}
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

export default Header;
