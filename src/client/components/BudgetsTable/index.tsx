import { ChangeEventHandler, useEffect, useMemo } from "react";
import { Budget, NewBudgetGetResponse } from "server";
import { call, IsNow, useAppContext } from "client";
import BudgetComponent from "./BudgetComponent";
import "./index.css";

const BudgetsTable = () => {
  const {
    transactions,
    accounts,
    budgets,
    setBudgets,
    setCategories,
    selectedBudgetId,
    setSelectedBudgetId,
    selectedInterval,
  } = useAppContext();

  useEffect(() => {
    const budget = budgets.get(selectedBudgetId);
    if (!budget) return;

    setCategories((oldCategories) => {
      const newCategories = new Map(oldCategories);
      oldCategories.forEach((oldCategory) => {
        const { category_id } = oldCategory;
        const newCategory = { ...oldCategory };

        const isNow = new IsNow();

        newCategory.amount = 0;

        transactions.forEach((e) => {
          const transactionDate = new Date(e.authorized_date || e.date);
          if (!isNow.within(selectedInterval).from(transactionDate)) return;
          const account = accounts.get(e.account_id);
          if (account?.hide) return;
          if (e.label.category_id !== category_id) return;
          newCategory.amount = (newCategory.amount as number) - e.amount;
        });

        newCategories.set(category_id, newCategory);
      });
      return newCategories;
    });
  }, [
    transactions,
    accounts,
    setCategories,
    budgets,
    selectedBudgetId,
    selectedInterval,
  ]);

  const onClickAdd = async () => {
    const { data } = await call.get<NewBudgetGetResponse>("/api/new-budget");
    if (!data) return;

    const { budget_id } = data;

    const newBudget: Budget = {
      budget_id,
      name: "",
      capacity: { year: 0, month: 0, week: 0, day: 0 },
      iso_currency_code: "USD",
    };

    setBudgets((oldBudgets) => {
      const newBudgets = new Map(oldBudgets);
      newBudgets.set(budget_id, newBudget);
      return newBudgets;
    });

    setSelectedBudgetId(budget_id);
  };

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

  const selectedBudget = useMemo(
    () => budgets.get(selectedBudgetId),
    [budgets, selectedBudgetId]
  );

  return (
    <div className="BudgetsTable">
      <div>Budgets:</div>
      <div>
        <button onClick={onClickAdd}>+</button>
        <select value={selectedBudgetId} onChange={onChangeBudget}>
          <option>Select Budget</option>
          {budgetOptions}
        </select>
      </div>
      {selectedBudget && (
        <BudgetComponent key={selectedBudgetId} budget={selectedBudget} />
      )}
    </div>
  );
};

export default BudgetsTable;
