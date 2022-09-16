import { useState, useMemo, useRef, useEffect } from "react";
import { Budget, DeepPartial, NewSectionGetResponse, Transaction } from "server";
import { useAppContext, numberToCommaString, currencyCodeToSymbol, call } from "client";
import SectionBar from "./SectionBar";
import Bar from "./common/Bar";
import "./index.css";
import { EditButton, CapacityInput, NameInput, TransactionsList } from "./common";

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
  const [isIncomeSelected, setIsIncomeSelected] = useState(false);
  const [childrenHeight, setChildrenHeight] = useState(0);

  const transactionsDivRef = useRef<HTMLDivElement>(null);

  const observerRef = useRef(
    new ResizeObserver((entries) => {
      const element = entries[0];
      const { height } = element.contentRect;
      setChildrenHeight(height);
    })
  );

  useEffect(() => {
    const childrenDiv = transactionsDivRef.current;
    const observer = observerRef.current;
    if (childrenDiv) observer.observe(childrenDiv);
    return () => {
      if (childrenDiv) observer.unobserve(childrenDiv);
    };
  }, []);

  const transactionsArray = useMemo(() => {
    const newTransactionsArray: Transaction[] = [];
    const viewDateClone = viewDate.clone();
    transactions.forEach((e) => {
      const account = accounts.get(e.account_id);
      if (!account) return;
      const hidden = account.hide;
      const transactionDate = new Date(e.authorized_date || e.date);
      const within = viewDateClone.has(transactionDate);
      const transactionBudget = e.label.budget_id;
      const accountBudget = account.label.budget_id;
      const includedInBudget = (transactionBudget || accountBudget) === budget_id;
      const isIncome = e.amount < 0;
      if (!hidden && within && includedInBudget && isIncome) {
        newTransactionsArray.push(e);
      }
    });

    return newTransactionsArray;
  }, [transactions, accounts, budget_id, viewDate]);

  const onClickBudgetInfo = () => {
    if (isIncomeSelected) {
      setChildrenHeight(0);
      setTimeout(() => setIsIncomeSelected((s) => !s), 100);
      return;
    }
    setChildrenHeight(0);
    setTimeout(() => setIsIncomeSelected((s) => !s), 100);
  };

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
      if (amount < 0) incomeTotal -= amount;
      else unlabeledTotal += amount;
    });
    return { unlabeledTotal, incomeTotal };
  }, [transactions, accounts, budget_id, viewDate]);

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

  return (
    <div className="BudgetBars">
      <div
        className="budgetInfo"
        onMouseLeave={() => setIsEditting(false)}
        onClick={() => {
          setIsEditting(false);
          onClickBudgetInfo();
        }}
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
                {numberToCommaString(currentTotal + unlabeledTotal)}
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
          <Bar className="income" ratio={Math.min(incomeRatio, 1)} />
          <div className="infoText">
            <div>
              <span>Earned {currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <span className="currentTotal">{numberToCommaString(incomeTotal)}</span>
              {incomeRatio >= 1 && <span>&nbsp;✔︎</span>}
            </div>
          </div>
        </div>
      </div>
      <div className="children" style={{ height: childrenHeight }}>
        <div ref={transactionsDivRef}>
          {isIncomeSelected && <TransactionsList transactionsArray={transactionsArray} />}
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
