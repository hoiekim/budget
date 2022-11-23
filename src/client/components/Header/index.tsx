import { ChangeEventHandler, ReactNode, useMemo, useState } from "react";
import { useAppContext, useSync, call } from "client";
import { Budget, Interval, NewBudgetGetResponse } from "server";
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
    setBudgets,
    viewDate,
    setViewDate,
  } = useAppContext();

  const [isHamburgerOpen, setIsHamburgerOpen] = useState(false);

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
    <a
      href={target}
      onClick={(e) => {
        e.preventDefault();
        go(target);
      }}
    >
      {children}
    </a>
  );

  const budgetOptions = useMemo(() => {
    const components: JSX.Element[] = [];
    budgets.forEach((e) => {
      const component = (
        <option key={e.budget_id} value={e.budget_id}>
          {e.name || "Unnamed"}
        </option>
      );
      components.push(component);
    });
    return components;
  }, [budgets]);

  const onChangeBudget: ChangeEventHandler<HTMLSelectElement> = (e) => {
    const { value } = e.target;
    if (value === "add_new_budget") onClickAddBudget();
    else setSelectedBudgetId(e.target.value);
  };

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

  const onClickAddBudget = async () => {
    const { data } = await call.get<NewBudgetGetResponse>("/api/new-budget");
    if (!data) return;

    const { budget_id } = data;
    setSelectedBudgetId(budget_id);
    const newBudget: Budget = {
      budget_id,
      name: "",
      capacities: { year: 0, month: 0, week: 0, day: 0 },
      iso_currency_code: "USD",
    };
    setBudgets((oldBudgets) => {
      const newBudgets = new Map(oldBudgets);
      newBudgets.set(budget_id, newBudget);
      return newBudgets;
    });
  };

  const getIntervalOptionText = (interval: Interval, fallback: string) => {
    if (viewDate.getInterval() !== interval) return fallback;
    return viewDate.toString();
  };

  return (
    <div className="Header" style={{ display: user ? undefined : "none" }}>
      <div className="viewController">
        <div>
          <select
            className="budgetSelect"
            value={selectedBudgetId}
            onChange={onChangeBudget}
            disabled={path === "/transactions"}
          >
            {!selectedBudgetId && <option>Select Budget</option>}
            {budgetOptions}
            <option value="add_new_budget">+ New Budget</option>
          </select>
        </div>
        <div>
          <button onClick={onClickPreviousView}>{"<"}</button>
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
          <button onClick={onClickNextView}>{">"}</button>
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
        <Navigator target="/">Budget</Navigator>
        <Navigator target="/accounts">Accounts</Navigator>
        <Navigator target="/transactions">Transactions</Navigator>
      </div>
    </div>
  );
};

export default Header;
