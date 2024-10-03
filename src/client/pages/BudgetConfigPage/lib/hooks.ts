import { call, useAppContext } from "client";
import {
  Budget,
  BudgetDictionary,
  Category,
  CategoryDictionary,
  Data,
  Dictionary,
  Section,
  SectionDictionary,
} from "common";
import { BudgetFamily } from "common/models/BudgetFamily";

export const useEventHandlers = (
  id: string,
  category?: Category,
  section?: Section,
  budget?: Budget
) => ({
  save: useSave(id, category, section, budget),
  remove: useRemove(id, category, section, budget),
});

export const useSave = (id: string, category?: Category, section?: Section, _budget?: Budget) => {
  const { setData, viewDate } = useAppContext();
  const apiPath = category ? "category" : section ? "section" : "budget";
  const idKey = category ? "category_id" : section ? "section_id" : "budget_id";
  const dataKey = category ? "categories" : section ? "sections" : "budgets";
  const DynamicBudgetFamily: typeof BudgetFamily = category ? Category : section ? Section : Budget;
  const DynamicBudgetFamilyDictionary: typeof Dictionary = category
    ? CategoryDictionary
    : section
    ? SectionDictionary
    : BudgetDictionary;

  const save = async (updatedBudgetFamily: Partial<BudgetFamily>) => {
    const { status } = await call.post(`/api/${apiPath}`, {
      ...updatedBudgetFamily,
      [idKey]: id,
    });

    if (status !== "success") throw new Error(`Failed to update ${apiPath}: ${id}`);

    setData((oldData) => {
      const newData = new Data(oldData);
      const oldBudgetFamily = oldData[dataKey].get(id);
      if (!oldBudgetFamily) return oldData;
      const newBudgetFamily = new DynamicBudgetFamily({
        ...oldBudgetFamily,
        ...updatedBudgetFamily,
      });
      const date = viewDate.getDate();
      const interval = viewDate.getInterval();
      const newCapacityValue = newBudgetFamily.getActiveCapacity(date)[interval];
      const oldCapacityValue = oldBudgetFamily.getActiveCapacity(date)[interval];
      const capacityDiff = newCapacityValue - oldCapacityValue;
      if (category) {
        const parentSection = newData.sections.get((newBudgetFamily as Category).section_id)!;
        parentSection.child_category_capacity_total += capacityDiff;
        const sectionCapacity = parentSection.getActiveCapacity(date)[interval];
        const isSectionSynced = parentSection.child_category_capacity_total === sectionCapacity;
        parentSection.is_children_synced = isSectionSynced;
        const parentBudget = newData.budgets.get(parentSection.budget_id)!;
        parentBudget.child_category_capacity_total += capacityDiff;
        const budgetCapacity = parentBudget.getActiveCapacity(date)[interval];
        const isBudgetSynced = parentBudget.child_category_capacity_total === budgetCapacity;
        parentBudget.is_children_synced = isBudgetSynced;
      } else if (section) {
        const is_capacity_synced =
          newBudgetFamily.child_category_capacity_total === newCapacityValue;
        newBudgetFamily.is_children_synced = is_capacity_synced;
        const parentBudget = newData.budgets.get((newBudgetFamily as Section).budget_id)!;
        parentBudget.child_section_capacity_total += capacityDiff;
        const budgetCapacity = parentBudget.getActiveCapacity(date)[interval];
        const isBudgetSynced = parentBudget.child_section_capacity_total === budgetCapacity;
        parentBudget.is_children_synced = isBudgetSynced;
      } else {
        const is_capacity_synced =
          newBudgetFamily.child_category_capacity_total === newCapacityValue;
        const is_section_synced = newBudgetFamily.child_section_capacity_total === newCapacityValue;
        newBudgetFamily.is_children_synced = is_capacity_synced && is_section_synced;
      }
      const newDictionary = new DynamicBudgetFamilyDictionary(newData[dataKey] as any);
      newDictionary.set(id, newBudgetFamily as any);
      newData[dataKey] = newDictionary;
      return newData as any;
    });
  };

  return save;
};

export const useRemove = (id: string, category?: Category, section?: Section, budget?: Budget) => {
  const { data, setData } = useAppContext();
  const { transactions, categories } = data;
  const budgetLike = category || section || budget;
  const name = budgetLike?.name || "Unnamed";
  const apiPath = category ? "category" : section ? "section" : "budget";
  const dataKey = category ? "categories" : section ? "sections" : "budgets";
  const DynamicBudgetFamilyDictionary: typeof Dictionary = category
    ? CategoryDictionary
    : section
    ? SectionDictionary
    : BudgetDictionary;
  const queryString = "?" + new URLSearchParams({ id }).toString();

  const remove = async () => {
    let shouldConfirm = false;

    if (category) {
      let iterator = transactions.values();
      let iteratorResult = iterator.next();
      while (!iteratorResult.done) {
        const transaction = iteratorResult.value;
        if (transaction.label.category_id === id) {
          shouldConfirm = true;
          break;
        }
        iteratorResult = iterator.next();
      }
    } else if (section) {
      let iterator = categories.values();
      let iteratorResult = iterator.next();
      while (!iteratorResult.done) {
        const category = iteratorResult.value;
        if (category.section_id === id) {
          shouldConfirm = true;
          break;
        }
        iteratorResult = iterator.next();
      }
    } else {
      shouldConfirm = true;
    }

    if (shouldConfirm) {
      const confirm = window.confirm(`Do you want to delete ${apiPath}: ${name}?`);
      if (!confirm) return;
    }

    const { status } = await call.delete(`/api/${apiPath}` + queryString);
    if (status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newDictionary = new DynamicBudgetFamilyDictionary(newData[dataKey] as any);
        newDictionary.delete(id);
        newData[dataKey] = newDictionary;
        return newData;
      });
    }
  };

  return remove;
};
