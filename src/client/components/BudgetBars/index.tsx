import { useState, useMemo, useRef } from "react";
import { Budget, DeepPartial, NewSectionGetResponse } from "server";
import {
  useAppContext,
  numberToCommaString,
  currencyCodeToSymbol,
  IsDate,
  call,
} from "client";
import SectionBar from "./SectionBar";
import Bar from "./common/Bar";
import "./index.css";
import { CapacityInput, NameInput } from "./common";

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

  const [isEditting, setIsEditting] = useState(!name);

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

  const labeledRatio = currentTotal / capacity || 0;
  const unlabledRatio = unlabeledTotal / capacity || 0;
  const incomeRatio = incomeTotal / capacity || 0;

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = (updatedBudget: DeepPartial<Budget> = {}, onError?: () => void) => {
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
        if (onError) onError();
      }
    }, 500);
  };

  const onClickDelete = async () => {
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

  const onClickEdit = () => setIsEditting((s) => !s);

  return (
    <div className="BudgetBars">
      <div className="budgetInfo" onMouseLeave={() => setIsEditting(false)}>
        <div className="title">
          <NameInput
            defaultValue={name}
            isEditting={isEditting}
            submit={(value, onError) => submit({ name: value }, onError)}
          />
          <div className="buttons">
            {isEditting ? (
              <button className="delete colored" onClick={onClickDelete}>
                ✕
              </button>
            ) : (
              <button className="edit" onClick={onClickEdit}>
                ✎
              </button>
            )}
          </div>
        </div>
        <div className="statusBarWithText">
          <Bar ratio={labeledRatio} unlabledRatio={unlabledRatio} />
          <div className="infoText">
            <div>
              <span>Spent {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="currentTotal">
                {numberToCommaString(currentTotal + unlabeledTotal)}
              </span>
              <span>&nbsp;of {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <CapacityInput
                defaultValue={numberToCommaString(capacities[selectedInterval])}
                isEditting={isEditting}
                submit={(value, onError) =>
                  submit({ capacities: { [selectedInterval]: +value } }, onError)
                }
              />
            </div>
          </div>
          <Bar className="income" ratio={incomeRatio} />
          <div className="infoText">
            <div>
              <span>Earned {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="currentTotal">{numberToCommaString(incomeTotal)}</span>
              {incomeRatio >= 1 && <span>&nbsp;✔︎</span>}
            </div>
          </div>
        </div>
      </div>
      <div className="children">
        <div>
          {sectionComponents}
          <div className="addButton">
            <button onClick={onClickAddSection}>+</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BudgetBar;
