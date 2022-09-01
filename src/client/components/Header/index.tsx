import { ChangeEventHandler, ReactNode, useMemo } from "react";
import { useAppContext, useSync, call, getDateStringByInterval } from "client";
import { Interval } from "server";
import "./index.css";

const Header = () => {
  const {
    user,
    setUser,
    router,
    selectedBudgetId,
    setSelectedBudgetId,
    selectedInterval,
    setSelectedInterval,
    budgets,
    viewDate,
    setViewDate,
  } = useAppContext();
  const { clean } = useSync();
  const { path, go } = router;

  const logout = () => {
    call.delete("/api/login").then((r) => {
      setUser(undefined);
      clean();
    });
  };

  type NavigatorProps = { target: string; children: ReactNode };
  const Navigator = ({ target, children }: NavigatorProps) => (
    <button disabled={path === target} onClick={() => go(target)}>
      {children}
    </button>
  );

  const budgetOptions = useMemo(() => {
    const components: JSX.Element[] = [];
    budgets.forEach((e) => {
      const conponent = (
        <option key={e.budget_id} value={e.budget_id}>
          {e.name || "Unnamed"}
        </option>
      );
      components.push(conponent);
    });
    return components;
  }, [budgets]);

  const onChangeBudget: ChangeEventHandler<HTMLSelectElement> = (e) => {
    setSelectedBudgetId(e.target.value);
  };

  const onClickPreviousView = () => {
    setViewDate((oldViewDate) => {
      const year = oldViewDate.getFullYear();
      const month = oldViewDate.getMonth();
      const date = oldViewDate.getDate();
      const day = oldViewDate.getDay();
      const newViewDate = new Date(year, month, date);
      switch (selectedInterval) {
        case "year":
          newViewDate.setDate(1);
          newViewDate.setMonth(0);
          break;
        case "month":
          newViewDate.setDate(1);
          break;
        case "week":
          const lastMonday = date - day + (day === 0 ? -6 : 1);
          newViewDate.setDate(lastMonday);
          break;
      }
      newViewDate.setMilliseconds(-1);
      return newViewDate;
    });
  };

  const onClickNextView = () => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const date = viewDate.getDate();
    const day = viewDate.getDay();
    const newViewDate = new Date(year, month, date);
    switch (selectedInterval) {
      case "year":
        newViewDate.setDate(1);
        newViewDate.setMonth(0);
        newViewDate.setFullYear(year + 2);
        break;
      case "month":
        newViewDate.setDate(1);
        newViewDate.setMonth(month + 2);
        break;
      case "week":
        const lastMonday = date - day + (day === 0 ? -6 : 1);
        const nextNextMonday = lastMonday + 7 * 2;
        newViewDate.setDate(nextNextMonday);
        break;
      case "day":
        newViewDate.setDate(date + 2);
        break;
    }
    newViewDate.setMilliseconds(-1);
    setViewDate(newViewDate);
  };

  return (
    <div className="Header" style={{ display: user ? undefined : "none" }}>
      <div className="viewController">
        <select value={selectedBudgetId} onChange={onChangeBudget}>
          <option>Select Budget</option>
          {budgetOptions}
        </select>
        <div>
          <button onClick={onClickPreviousView}>{"<"}</button>
          <span>{getDateStringByInterval(viewDate, selectedInterval)}</span>
          <button onClick={onClickNextView}>{">"}</button>
        </div>
        <select
          value={selectedInterval}
          onChange={(e) => {
            const value = e.target.value as Interval;
            setSelectedInterval(value);
          }}
        >
          <option value="year">Yearly</option>
          <option value="month">Monthly</option>
          <option value="week">Weekly</option>
          <option value="day">Daily</option>
        </select>
      </div>
      <div>
        <div>
          <button disabled={!user} onClick={logout}>
            Logout
          </button>
        </div>
        <div>
          <Navigator target="/">Home</Navigator>
        </div>
        <div>
          <Navigator target="/budgets">Budgets</Navigator>
        </div>
        <div>
          <Navigator target="/accounts">Accounts</Navigator>
        </div>
        <div>
          <Navigator target="/transactions">Transactions</Navigator>
        </div>
      </div>
    </div>
  );
};

export default Header;
