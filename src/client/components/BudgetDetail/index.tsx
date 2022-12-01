import { useState, useMemo, useRef } from "react";
import { Budget, DeepPartial, NewSectionGetResponse } from "server";
import { useAppContext, numberToCommaString, currencyCodeToSymbol, call } from "client";
import { Bar, EditButton, CapacityInput, NameInput } from "client/components";
import SectionBar from "./SectionBar";
import "./index.css";

interface Props {
  budget: Budget & { amount?: number };
}

const BudgetDetail = ({ budget }: Props) => {
  const { budget_id, name, capacities, iso_currency_code, amount } = budget;

  const {
    transactions,
    accounts,
    budgets,
    setBudgets,
    sections,
    setSections,
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

  const unlabeledTotal = useMemo(() => {
    let result = 0;
    const viewDateClone = viewDate.clone();
    transactions.forEach((e) => {
      const { account_id, authorized_date, date, label, amount } = e;
      const transactionDate = new Date(authorized_date || date);
      if (!viewDateClone.has(transactionDate)) return;
      const account = accounts.get(account_id);
      if (!account || account.hide) return;
      const { category_id, budget_id: labelBudgetId } = label;
      if (category_id) return;
      if ((labelBudgetId || account.label.budget_id) !== budget_id) return;
      if (amount > 0) result += amount;
    });
    return result;
  }, [transactions, accounts, budget_id, viewDate]);

  const labeledRatio = (amount || 0) / capacity || 0;
  const unlabledRatio = unlabeledTotal / capacity || 0;

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

  const onDelete = async () => {
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

  const onEdit = () => setIsEditting((s) => !s);

  // TODO: add a bar for unsorted items
  return (
    <div className="BudgetDetail BudgetBar">
      <div
        className="budgetInfo"
        onMouseLeave={() => setIsEditting(false)}
        onClick={() => setIsEditting(false)}
      >
        <div className="title">
          <NameInput
            defaultValue={name}
            isEditting={isEditting}
            submit={(value, onError) => {
              submit({ name: value }, onError);
            }}
          />
          <div className="buttons">
            <EditButton isEditting={isEditting} onEdit={onEdit} onDelete={onDelete} />
          </div>
        </div>
        <div className="statusBarWithText">
          <Bar ratio={labeledRatio} unlabledRatio={unlabledRatio} />
          <div className="infoText">
            <div>
              <span>Spent {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="currentTotal">
                {numberToCommaString((amount || 0) + unlabeledTotal)}
              </span>
              <span>&nbsp;of {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <CapacityInput
                key={`${budget_id}_${selectedInterval}`}
                defaultValue={numberToCommaString(capacity)}
                isEditting={isEditting}
                submit={(value, onError) => {
                  submit({ capacities: { [selectedInterval]: +value } }, onError);
                }}
              />
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

export default BudgetDetail;
