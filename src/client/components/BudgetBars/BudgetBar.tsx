import { useState, useMemo, useEffect, useRef } from "react";
import { Budget, DeepPartial, NewSectionGetResponse } from "server";
import {
  useAppContext,
  numberToCommaString,
  currencyCodeToSymbol,
  IsDate,
  call,
} from "client";
import SectionBar from "./SectionBar";
import "./index.css";

interface Props {
  budget: Budget;
}

const BudgetBar = ({ budget }: Props) => {
  const { budget_id, name, capacities, iso_currency_code } = budget;

  const {
    transactions,
    accounts,
    budgets,
    setBudgets,
    sections,
    setSections,
    categories,
    setSelectedBudgetId,
    selectedInterval,
    viewDate,
  } = useAppContext();

  const [nameInput, setNameInput] = useState(name);
  const [capacityInput, setCapacityInput] = useState(() => {
    return numberToCommaString(capacities[selectedInterval]);
  });

  const [numeratorWidth, setNumeratorWidth] = useState(0);
  const [unlabeledNumeratorWidth, setUnlabledNumeratorWidth] = useState(0);
  const [incomeNumeratorWidth, setIncomeNumeratorWidth] = useState(0);

  const capacity = capacities[selectedInterval] || 0;

  const sectionComponents = useMemo(() => {
    const components: JSX.Element[] = [];
    sections.forEach((e) => {
      if (e.budget_id !== budget_id) return;
      const component = <SectionBar key={e.section_id} section={e} />;
      components.push(component);
    });
    return components;
  }, [sections, budget_id]);

  const currentTotal = useMemo(() => {
    let total = 0;
    categories.forEach((e) => {
      if (!e.amount) return;
      const parentSection = sections.get(e.section_id);
      if (!parentSection) return;
      const parentBudget = budgets.get(parentSection.budget_id);
      if (!parentBudget) return;
      if (parentBudget !== budget) return;
      total += e.amount || 0;
    });
    return total;
  }, [categories, sections, budgets, budget]);

  const { unlabeledTotal, incomeTotal } = useMemo(() => {
    let unlabeledTotal = 0;
    let incomeTotal = 0;
    const isViewDate = new IsDate(viewDate);
    transactions.forEach((e) => {
      const { account_id, authorized_date, date, label, amount } = e;
      const transactionDate = new Date(authorized_date || date);
      if (!isViewDate.within(selectedInterval).from(transactionDate)) return;
      const account = accounts.get(account_id);
      if (!account || account.hide) return;
      const { category_id, budget_id: labelBudgetId } = label;
      if (category_id) return;
      if ((labelBudgetId || account.label.budget_id) !== budget_id) return;
      if (amount < 0) incomeTotal -= amount;
      else unlabeledTotal += amount;
    });
    return { unlabeledTotal, incomeTotal };
  }, [selectedInterval, transactions, accounts, budget_id, viewDate]);

  const combinedRatio = (currentTotal + unlabeledTotal) / capacity;
  const labeledRatio = currentTotal / (currentTotal + unlabeledTotal) || 0;
  const unlabledRatio = unlabeledTotal / (currentTotal + unlabeledTotal) || 0;
  const incomeRatio = incomeTotal / capacity || 0;

  useEffect(() => {
    setNumeratorWidth(Math.min(1, labeledRatio) * 100);
    setUnlabledNumeratorWidth(Math.min(1 - labeledRatio, unlabledRatio) * 100);
    setIncomeNumeratorWidth(Math.min(1, incomeRatio) * 100);
    return () => {
      setNumeratorWidth(0);
      setUnlabledNumeratorWidth(0);
      setIncomeNumeratorWidth(0);
    };
  }, [labeledRatio, unlabledRatio, incomeRatio]);

  const revertInputs = () => {
    setNameInput(name);
    setCapacityInput(numberToCommaString(capacities[selectedInterval]));
  };

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = (updatedBudget: DeepPartial<Budget> = {}, delay = 500) => {
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
  };

  const onClickRemoveBudget = async () => {
    if (!window.confirm(`Do you want to delete budget: ${name || "Unnamed"}?`)) return;
    const queryString = "?" + new URLSearchParams({ id: budget_id }).toString();
    const { status } = await call.delete("/api/budget" + queryString);
    if (status === "success") {
      setBudgets((oldBudgets) => {
        const newBudgets = new Map(oldBudgets);
        newBudgets.delete(budget_id);
        return newBudgets;
      });
      const nextBudget = budgets.values().next().value;
      setSelectedBudgetId(nextBudget?.budget_id);
    }
  };

  const onClickAddSection = async () => {
    const queryString = "?" + new URLSearchParams({ parent: budget_id }).toString();
    const { data } = await call.get<NewSectionGetResponse>(
      "/api/new-section" + queryString
    );

    setSections((oldSections) => {
      const newSections = new Map(oldSections);
      const section_id = data?.section_id;
      if (section_id) {
        newSections.set(section_id, {
          section_id,
          budget_id,
          name: "",
          capacities: { year: 0, month: 0, week: 0, day: 0 },
        });
      }
      return newSections;
    });
  };

  return (
    <div className="BudgetBar">
      <h2>Budgets</h2>
      <div className="budgetInfo">
        <div className="title">
          <input
            placeholder="name"
            value={nameInput}
            onChange={(e) => {
              const { value } = e.target;
              setNameInput(value);
              submit({ name: value });
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <button onClick={onClickRemoveBudget}>✕</button>
        </div>
        <div className="statusBarWithText">
          <div className="statusBar">
            <div className="contentWithoutPadding">
              <div style={{ width: combinedRatio * 100 + "%" }}>
                <div style={{ width: numeratorWidth + "%" }} className="numerator" />
                <div
                  style={{
                    border: unlabledRatio === 0 ? "none" : undefined,
                    left: numeratorWidth + "%",
                    width: unlabeledNumeratorWidth + "%",
                  }}
                  className="unlabeledNumerator"
                />
              </div>
            </div>
          </div>
          <div className="infoText">
            <div>
              <span>Spent {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="currentTotal">{numberToCommaString(currentTotal)}</span>
            </div>
            <div>
              <span>of {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <input
                className="capacityInput"
                value={capacityInput}
                onKeyPress={(e) => !/[0-9.-]/.test(e.key) && e.preventDefault()}
                onChange={(e) => {
                  const { value } = e.target;
                  setCapacityInput(value);
                  submit({ capacities: { [selectedInterval]: +value } });
                }}
                onFocus={(e) => setCapacityInput(e.target.value.replaceAll(",", ""))}
                onBlur={(e) =>
                  setCapacityInput(numberToCommaString(+e.target.value || 0))
                }
              />
            </div>
          </div>
          <div className="statusBar income">
            <div className="contentWithoutPadding">
              <div
                style={{ width: incomeNumeratorWidth + "%" }}
                className="incomeNumerator"
              />
            </div>
          </div>
          <div className="infoText">
            <div>
              <span>Earned {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="currentTotal">{numberToCommaString(incomeTotal)}</span>
            </div>
            <div className="icon">{incomeRatio >= 1 && "✓"}</div>
          </div>
        </div>
      </div>
      <div className="children">
        <div>{sectionComponents}</div>
      </div>
      <div className="addButton">
        <button onClick={onClickAddSection}>+</button>
      </div>
    </div>
  );
};

export default BudgetBar;
