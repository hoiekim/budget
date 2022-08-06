import { useAppContext, numberToCommaString, call } from "client";
import { useCallback, useRef, useState, useMemo } from "react";
import { Budget, Interval, NewSectionResponse } from "server";
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
  const { budgets, setBudgets, sections, setSections, categories } = useAppContext();

  const onClickAdd = async () => {
    const queryString = "?" + new URLSearchParams({ parent: budget_id }).toString();
    const { data } = await call.get<NewSectionResponse>("/api/new-section" + queryString);

    setSections((oldSections) => {
      const newSections = new Map(oldSections);
      const section_id = data?.section_id;
      if (section_id) {
        newSections.set(section_id, {
          section_id,
          budget_id,
          name: "",
          capacity: 0,
        });
      }
      return newSections;
    });
  };

  const revertInputs = useCallback(() => {
    setNameInput(name);
    setCapacityInput(numberToCommaString(capacity));
    setIntervalInput(interval);
    setCurrencyCodeInput(iso_currency_code);
  }, [
    name,
    setNameInput,
    capacity,
    setCapacityInput,
    interval,
    setIntervalInput,
    iso_currency_code,
    setCurrencyCodeInput,
  ]);

  const sectionComponents = useMemo(() => {
    return Array.from(sections.values())
      .filter((e) => e.budget_id === budget_id)
      .map((e, i) => {
        return <SectionComponent key={i} section={e} />;
      });
  }, [sections, budget_id]);

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = useCallback(
    (updatedBudget: Partial<Budget> = {}, delay = 500) => {
      clearTimeout(timeout.current);
      timeout.current = setTimeout(async () => {
        try {
          const { status } = await call.post("/api/budget", {
            ...updatedBudget,
            budget_id,
          });
          if (status === "success") {
            setBudgets((oldBudgets) => {
              const newBudgets = new Map(oldBudgets);
              const oldBudget = oldBudgets.get(budget_id);
              const newBudget = { ...oldBudget, ...updatedBudget };
              newBudgets.set(budget_id, newBudget as Budget);
              return newBudgets;
            });
          } else throw new Error(`Failed to update budget: ${budget_id}`);
        } catch (error: any) {
          console.error(error);
          revertInputs();
        }
      }, delay);
    },
    [setBudgets, budget_id, revertInputs]
  );

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
  }, [budget_id, setBudgets]);

  const currentTotal = useMemo(() => {
    return Array.from(categories.values())
      .filter((e) => {
        if (!e.amount) return false;
        const parentSection = sections.get(e.section_id);
        if (!parentSection) return false;
        const parentBudget = budgets.get(parentSection.budget_id);
        if (!parentBudget) return false;
        return parentBudget === budget;
      })
      .reduce((acc, e) => acc + (e.amount || 0), 0);
  }, [categories, sections, budgets, budget]);

  return (
    <div className="BudgetComponent">
      <div className="budgetInfo">
        <button onClick={onClickRemove}>-</button>
        <input
          placeholder="name"
          value={nameInput}
          onChange={(e) => {
            const { value } = e.target;
            setNameInput(value);
            submit({ name: value });
          }}
        />
        <div className="currentTotal">{numberToCommaString(currentTotal)}</div>
        <span> / </span>
        <input
          value={capacityInput}
          onKeyPress={(e) => !/[0-9.-]/.test(e.key) && e.preventDefault()}
          onChange={(e) => {
            const { value } = e.target;
            setCapacityInput(value);
            submit({ capacity: +value });
          }}
          onFocus={(e) => setCapacityInput(e.target.value.replaceAll(",", ""))}
          onBlur={(e) => setCapacityInput(numberToCommaString(+e.target.value || 0))}
        />
        <select
          value={currencyCodeInput}
          onChange={(e) => {
            const { value } = e.target;
            setCurrencyCodeInput(value);
            submit({ iso_currency_code: value }, 0);
          }}
        >
          <option value="USD">USD</option>
        </select>
        <select
          value={intervalInput}
          onChange={(e) => {
            const value = e.target.value as Interval;
            setIntervalInput(value);
            submit({ interval: value }, 0);
          }}
        >
          <option value="year">per year</option>
          <option value="month">per month</option>
          <option value="week">per week</option>
          <option value="day">per day</option>
        </select>
      </div>
      <div className="children">
        <div>Sections:</div>
        <div>
          <button onClick={onClickAdd}>+</button>
        </div>
        <div>{sectionComponents}</div>
      </div>
    </div>
  );
};

export default BudgetComponent;
