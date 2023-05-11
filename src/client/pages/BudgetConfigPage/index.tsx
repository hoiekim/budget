import { useEffect, useState, useMemo } from "react";
import { useAppContext, PATH, call, useCalculator } from "client";
import {
  NameInput,
  Bar,
  CapacityInput,
  ActionButtons,
  Properties,
} from "client/components";
import {
  Budget,
  getDateString,
  getDateTimeString,
  MAX_FLOAT,
  Category,
  Section,
  currencyCodeToSymbol,
} from "common";

import "./index.css";

export type BudgetLikeConfigPageParams = {
  id: string;
};

const BudgetConfigPage = () => {
  const {
    budgets,
    setBudgets,
    sections,
    setSections,
    categories,
    setCategories,
    transactions,
    router,
    viewDate,
  } = useAppContext();

  const calculate = useCalculator();

  const { path, params, transition } = router;
  let id: string;
  if (path === PATH.BUDGET_CONFIG) id = params.get("id") || "";
  else id = transition.incomingParams.get("id") || "";

  const category = categories.get(id);
  const section = sections.get(id) || (category && sections.get(category.section_id));
  const budget = budgets.get(id) || (section && budgets.get(section.budget_id));

  const data = useMemo(() => {
    return category || section || budget || new Budget();
  }, [category, section, budget]);

  const {
    name,
    capacities,
    sorted_amount = 0,
    unsorted_amount = 0,
    roll_over,
    roll_over_start_date: roll_date,
  } = data;

  const capacity = data.getValidCapacity(viewDate);
  const isInfinite = capacity === MAX_FLOAT || capacity === -MAX_FLOAT;
  const isIncome = typeof capacity === "number" && capacity < 0;
  const getCapacityInput = () => (isInfinite ? 0 : capacity * (isIncome ? -1 : 1));
  const getRollDateInput = () => (roll_date ? new Date(roll_date) : new Date());
  const [nameInput, setNameInput] = useState(name);
  const [capacityInput, setCapacityInput] = useState(getCapacityInput());
  const [isInfiniteInput, setIsInfiniteInput] = useState(isInfinite);
  const [isIncomeInput, setIsIncomeInput] = useState(isIncome);
  const [isRollOverInput, setIsRollOverInput] = useState(roll_over);
  const [rollDateInput, setRollDateInput] = useState(getRollDateInput());

  useEffect(() => {
    if (!data) return;
    const { name, roll_over, roll_over_start_date: roll_date } = data;
    const capacity = data.getValidCapacity(viewDate);
    const isInfinite = capacity === MAX_FLOAT || capacity === -MAX_FLOAT;
    const isIncome = typeof capacity === "number" && capacity < 0;
    const getCapacityInput = () => (isInfinite ? 0 : capacity * (isIncome ? -1 : 1));
    const getRollDateInput = () => (roll_date ? new Date(roll_date) : new Date());
    setNameInput(name);
    setCapacityInput(getCapacityInput());
    setIsInfiniteInput(isInfinite);
    setIsIncomeInput(isIncome);
    setIsRollOverInput(roll_over);
    setRollDateInput(getRollDateInput);
  }, [data, viewDate]);

  if (!budget) return <></>;

  const iso_currency_code = budget?.iso_currency_code;
  const barCapacity = capacityInput * (isIncomeInput ? -1 : 1);
  const labeledRatio = isInfiniteInput ? undefined : sorted_amount / barCapacity;
  const unlabledRatio = isInfiniteInput ? undefined : unsorted_amount / barCapacity;

  const interval = viewDate.getInterval();

  const finishEditing = () => router.back();

  const onSubmit = async (updatedData: Partial<Budget | Section | Category>) => {
    if (category) {
      const { status } = await call.post("/api/category", {
        ...updatedData,
        category_id: id,
      });
      if (status === "success") {
        setCategories((oldCategories) => {
          const newCategories = new Map(oldCategories);
          const oldCategory = oldCategories.get(id);
          if (!oldCategory) return newCategories;
          const newCategory = new Category({ ...oldCategory, ...updatedData });
          newCategories.set(id, newCategory);
          return newCategories;
        });
      } else throw new Error(`Failed to update category: ${id}`);
    } else if (section) {
      const { status } = await call.post("/api/section", {
        ...updatedData,
        section_id: id,
      });
      if (status === "success") {
        setSections((oldSections) => {
          const newSections = new Map(oldSections);
          const oldSection = oldSections.get(id);
          if (!oldSection) return newSections;
          const newSection = new Section({ ...oldSection, ...updatedData });
          newSections.set(id, newSection);
          return newSections;
        });
      } else throw new Error(`Failed to update section: ${id}`);
    } else if (budget) {
      const { status } = await call.post("/api/budget", {
        ...updatedData,
        budget_id: id,
      });
      if (status === "success") {
        setBudgets((oldBudgets) => {
          const newBudgets = new Map(oldBudgets);
          const oldBudget = oldBudgets.get(id);
          if (!oldBudget) return newBudgets;
          const newBudget = new Budget({ ...oldBudget, ...updatedData });
          newBudgets.set(id, newBudget);
          return newBudgets;
        });
      } else throw new Error(`Failed to update budget: ${id}`);
    }
  };

  const onDelete = async () => {
    const queryString = "?" + new URLSearchParams({ id }).toString();

    if (category) {
      let transactionIterator = transactions.values();
      let iteratorResult = transactionIterator.next();
      let isCategoryUsed: boolean | undefined;
      while (!iteratorResult.done) {
        const transaction = iteratorResult.value;
        if (transaction.label.category_id === id) {
          isCategoryUsed = true;
          break;
        }
        iteratorResult = transactionIterator.next();
      }

      if (isCategoryUsed) {
        const categoryName = category.name || "Unnamed";
        const confirm = window.confirm(
          `Do you want to delete category: ${categoryName}?`
        );
        if (!confirm) return;
      }

      const { status } = await call.delete("/api/category" + queryString);
      if (status === "success") {
        setCategories((oldCategories) => {
          const newCategories = new Map(oldCategories);
          newCategories.delete(id);
          return newCategories;
        });
      }
    } else if (section) {
      let sectionIterator = categories.values();
      let iteratorResult = sectionIterator.next();
      let isSectionUsed: boolean | undefined;
      while (!iteratorResult.done) {
        const category = iteratorResult.value;
        if (category.section_id === id) {
          isSectionUsed = true;
          break;
        }
        iteratorResult = sectionIterator.next();
      }

      if (isSectionUsed) {
        const sectionName = section.name || "Unnamed";
        const confirm = window.confirm(`Do you want to delete section: ${sectionName}?`);
        if (!confirm) return;
      }

      const { status } = await call.delete("/api/section" + queryString);
      if (status === "success") {
        setSections((oldSections) => {
          const newSections = new Map(oldSections);
          newSections.delete(id);
          return newSections;
        });
      }
    } else if (budget) {
      const confirmMessage = `Do you want to delete budget: ${data?.name || "Unnamed"}?`;
      if (!window.confirm(confirmMessage)) return;
      const { status } = await call.delete("/api/budget" + queryString);
      if (status === "success") {
        setBudgets((oldBudgets) => {
          const newBudgets = new Map(oldBudgets);
          newBudgets.delete(id);
          return newBudgets;
        });
      }
    }

    finishEditing();
  };

  const onComplete = async () => {
    let calculatedCapacity = isInfiniteInput ? MAX_FLOAT : capacityInput;
    if (isIncomeInput) calculatedCapacity *= -1;
    try {
      await onSubmit({
        name: nameInput,
        capacities: [{ ...capacities[0], [interval]: calculatedCapacity }],
        roll_over: isRollOverInput,
        roll_over_start_date: getDateTimeString(getDateString(rollDateInput)),
      });
      if (isRollOverInput) calculate();
    } catch (error: any) {
      console.error(error);
    }
    finishEditing();
  };

  return (
    <div className="BudgetConfigPage">
      <div className="title">
        <NameInput defaultValue={name} onChange={(e) => setNameInput(e.target.value)} />
      </div>
      <div className="statusBarWithText">
        <Bar ratio={labeledRatio} unlabledRatio={unlabledRatio} noAlert={isIncomeInput} />
        <div className="infoText">
          <div>
            <table>
              <tbody>
                <tr>
                  {isInfiniteInput ? (
                    <td>
                      <span>Unlimited</span>
                    </td>
                  ) : (
                    <>
                      <td>
                        <span>{currencyCodeToSymbol(iso_currency_code)}</span>
                      </td>
                      <td>
                        <CapacityInput
                          key={`${id}_${interval}`}
                          defaultValue={getCapacityInput()}
                          onChange={(e) => setCapacityInput(Math.abs(+e.target.value))}
                        />
                      </td>
                    </>
                  )}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <Properties
        isIncome={isIncome}
        isIncomeInput={isIncomeInput}
        setIsIncomeInput={setIsIncomeInput}
        isInfinite={isInfinite}
        isInfiniteInput={isInfiniteInput}
        setIsInfiniteInput={setIsInfiniteInput}
        isRollOver={roll_over}
        isRollOverInput={isRollOverInput}
        setIsRollOverInput={setIsRollOverInput}
        rollOverStartDate={getRollDateInput()}
        rollOverStartDateInput={rollDateInput}
        setRollOverStartDateInput={setRollDateInput}
      />
      <ActionButtons
        onComplete={onComplete}
        onCancel={finishEditing}
        onDelete={onDelete}
      />
    </div>
  );
};

export default BudgetConfigPage;
