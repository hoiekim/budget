import { useAppContext, numberToCommaString, call } from "client";
import { useCallback, useRef, useState } from "react";
import { Budget, Interval } from "server";
import SectionComponent from "./SectionComponent";

interface Props {
  budget: Budget;
}

const BudgetComponent = ({ budget }: Props) => {
  const { budget_id, name, interval, capacity, iso_currency_code } = budget;

  const [nameInput, setNameInput] = useState(name);
  const [capacityInput, setCapacityInput] = useState(numberToCommaString(capacity));
  const [intervalInput, setIntervalInput] = useState<"" | Interval>(interval);
  const [currencyCodeInput, setCurrencyCodeInput] = useState(iso_currency_code);
  const { budgets, setBudgets, sections } = useAppContext();

  const sectionComponents = Array.from(sections.values())
    .filter((e) => e.budget_id === budget_id)
    .map((e, i) => {
      return <SectionComponent key={i} section={e} />;
    });

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = (delay = 500) => {
    clearTimeout(timeout.current);
    timeout.current = setTimeout(async () => {
      const capacity = +capacityInput.replaceAll(",", "");
      if (!nameInput || Number.isNaN(capacity) || !intervalInput) return;

      const newBudget: Budget = {
        budget_id,
        name: nameInput,
        capacity,
        interval: intervalInput,
        iso_currency_code: currencyCodeInput,
      };

      try {
        const { status } = await call.post("/api/budget", newBudget);
        if (status === "success") {
          setBudgets((oldBudgets) => {
            const newBudgets = new Map(oldBudgets);
            newBudgets.set(budget_id, newBudget);
            return newBudgets;
          });
        } else throw new Error(`Failed to update budget: ${budget_id}`);
      } catch (error: any) {
        console.error(error);
        const oldBudget = budgets.get(budget_id);
        if (!oldBudget) {
          throw new Error(`Failed to revert input for budget: ${budget_id}`);
        }
        setNameInput(oldBudget.name);
        setCapacityInput(numberToCommaString(oldBudget.capacity));
        setIntervalInput(oldBudget.interval);
        setCurrencyCodeInput(oldBudget.iso_currency_code);
      }
    }, delay);
  };

  const onClickRemove = useCallback(async () => {
    const queryString = "?" + new URLSearchParams({ id: budget_id }).toString();
    const { status } = await call.delete("/api/budget" + queryString);
    if (status === "success") {
      setBudgets((oldBudgets) => {
        const newBudgets = new Map(oldBudgets);
        newBudgets.delete(budget_id);
        return newBudgets;
      });
    }
  }, [budget_id]);

  // TODO: get total expenses
  const currentTotal = 10000;

  return (
    <div className="BudgetComponent">
      <div className="budgetInfo">
        <button onClick={onClickRemove}>-</button>
        <input
          placeholder="name"
          value={nameInput}
          onChange={(e) => {
            setNameInput(e.target.value);
            submit();
          }}
        />
        <select
          value={currencyCodeInput}
          onChange={(e) => {
            setCurrencyCodeInput(e.target.value);
            submit(0);
          }}
        >
          <option value="USD">USD</option>
        </select>
        <div className="currentTotal">{numberToCommaString(currentTotal)}</div>
        <span> / </span>
        <input
          value={capacityInput}
          onKeyPress={(e) => !/[0-9.-]/.test(e.key) && e.preventDefault()}
          onChange={(e) => {
            setCapacityInput(e.target.value);
            submit();
          }}
          onFocus={(e) => setCapacityInput(e.target.value.replaceAll(",", ""))}
          onBlur={(e) => setCapacityInput(numberToCommaString(+e.target.value || 0))}
        />
        <select
          value={intervalInput}
          onChange={(e) => {
            setIntervalInput(e.target.value as Interval);
            submit(0);
          }}
        >
          <option value="year">per year</option>
          <option value="month">per month</option>
          <option value="week">per week</option>
          <option value="day">per day</option>
        </select>
      </div>
      <div className="budgetChildren">
        <div>Sections:</div>
        <div>{sectionComponents}</div>
      </div>
    </div>
  );
};

export default BudgetComponent;
