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

export const useEventHandlers = (budgetLike: BudgetFamily | undefined, isSyncedInput: boolean) => ({
  save: useSave(budgetLike, isSyncedInput),
  remove: useRemove(budgetLike),
});

export const useSave = (budgetLike: BudgetFamily | undefined, isSyncedInput: boolean) => {
  const { setData, viewDate } = useAppContext();
  if (!budgetLike) return async (updatedBudgetFamily: Partial<BudgetFamily>) => {};
  const { id, type, dictionaryKey } = budgetLike;
  const idKey = type + "_id";
  const DynamicBudgetFamily: typeof BudgetFamily =
    type === "budget" ? Budget : type === "section" ? Section : Category;
  const DynamicBudgetFamilyDictionary: typeof Dictionary =
    type === "budget"
      ? BudgetDictionary
      : type === "section"
      ? SectionDictionary
      : CategoryDictionary;

  const save = async (updatedBudgetFamily: Partial<BudgetFamily>) => {
    const { status } = await call.post(`/api/${type}`, {
      ...updatedBudgetFamily,
      [idKey]: id,
    });

    if (status !== "success") throw new Error(`Failed to update ${type}: ${id}`);

    setData((oldData) => {
      const newData = new Data(oldData);
      const oldBudgetFamily = oldData[dictionaryKey].get(id);
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
      if (type === "category") {
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
      } else if (type === "section") {
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
      const newDictionary = new DynamicBudgetFamilyDictionary(newData[dictionaryKey] as any);
      newDictionary.set(id, newBudgetFamily as any);
      newData[dictionaryKey] = newDictionary;
      return newData as any;
    });
  };

  return save;
};

export const useRemove = (budgetLike?: BudgetFamily) => {
  const { data, setData } = useAppContext();
  const { transactions, categories } = data;
  if (!budgetLike) return async () => {};
  const name = budgetLike.name || "Unnamed";
  const { id, type, dictionaryKey } = budgetLike;
  const DynamicBudgetFamilyDictionary: typeof Dictionary =
    type === "budget"
      ? BudgetDictionary
      : type === "section"
      ? SectionDictionary
      : CategoryDictionary;

  const queryString = "?" + new URLSearchParams({ id }).toString();

  const remove = async () => {
    let shouldConfirm = false;

    if (type === "category") {
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
    } else if (type === "section") {
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
      const confirm = window.confirm(`Do you want to delete ${type}: ${name}?`);
      if (!confirm) return;
    }

    const { status } = await call.delete(`/api/${type}` + queryString);
    if (status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newDictionary = new DynamicBudgetFamilyDictionary(newData[dictionaryKey] as any);
        newDictionary.delete(id);
        newData[dictionaryKey] = newDictionary;
        return newData;
      });
    }
  };

  return remove;
};
