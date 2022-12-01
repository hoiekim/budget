import { MouseEventHandler, ReactNode, useState } from "react";
import { useAppContext, useSync, call, PATH } from "client";
import { Interval } from "server";
import "./index.css";

const Header = () => {
  const {
    user,
    setUser,
    router,
    selectedInterval,
    setSelectedInterval,
    viewDate,
    setViewDate,
  } = useAppContext();

  const [isHamburgerOpen, setIsHamburgerOpen] = useState(false);

  const { clean } = useSync();
  const { path, params, go, back } = router;

  const logout = () => {
    call.delete("/api/login").then((r) => {
      setUser(undefined);
      clean();
    });
  };

  type NavigatorProps = { target: PATH; children: ReactNode };
  const Navigator = ({ target, children }: NavigatorProps) => (
    <a
      className={path === target ? "selected" : undefined}
      href={target}
      onClick={(e) => {
        e.preventDefault();
        go(target, { animate: false });
      }}
    >
      {children}
    </a>
  );

  const onClickPreviousView = () => {
    setViewDate((oldViewDate) => {
      const newViewDate = oldViewDate.clone();
      newViewDate.previous();
      return newViewDate;
    });
  };

  const onClickNextView = () => {
    setViewDate((oldViewDate) => {
      const newViewDate = oldViewDate.clone();
      newViewDate.next();
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
    !params.toString() && !![BUDGETS, ACCOUNTS, TRANSACTIONS].find((e) => e === path);

  return (
    <div className="Header" style={{ display: user ? undefined : "none" }}>
      <div className="viewController">
        <div className="backButton">
          <button onClick={onClickBack} disabled={isBackButtonDisabled}>
            {isBackButtonDisabled ? "" : "←"}
          </button>
        </div>
        <div>
          <button onClick={onClickPreviousView}>
            <b>〈</b>
          </button>
          <select
            className="intervalSelect"
            value={selectedInterval}
            onChange={(e) => {
              const value = e.target.value as Interval;
              setSelectedInterval(value);
            }}
          >
            <option value="year">{getIntervalOptionText("year", "Yearly")}</option>
            <option value="month">{getIntervalOptionText("month", "Monthly")}</option>
            <option value="week">{getIntervalOptionText("week", "Weekly")}</option>
            <option value="day">{getIntervalOptionText("day", "Daily")}</option>
          </select>
          <button onClick={onClickNextView}>
            <b>〉</b>
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
      <div className="navigators">
        <Navigator target={BUDGETS}>Budget</Navigator>
        <Navigator target={ACCOUNTS}>Accounts</Navigator>
        <Navigator target={TRANSACTIONS}>Transactions</Navigator>
      </div>
    </div>
  );
};

export default Header;
