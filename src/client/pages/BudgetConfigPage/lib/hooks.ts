import { call, useAppContext } from "client";
import { Category, Data, Section, getBudgetClass, getBudgetDictionaryClass } from "common";
import { BudgetFamily } from "common/models/BudgetFamily";

export const useEventHandlers = () => ({
  save: useSave(),
  remove: useRemove(),
});

export const useSave = () => {
  const { setData, viewDate } = useAppContext();

  const save = async <T extends BudgetFamily>(original: T, updated: Partial<T>) => {
    const { id, type, dictionaryKey } = original;
    const DynamicBudgetFamily = getBudgetClass(type);
    const DynamicBudgetFamilyDictionary = getBudgetDictionaryClass(type);
    const { status } = await call.post(`/api/${type}`, { ...updated, [`${type}_id`]: id });

    if (status !== "success") throw new Error(`Failed to update ${type}: ${id}`);

    setData((oldData) => {
      const newData = new Data(oldData);
      const oldBudgetLike = oldData[dictionaryKey].get(id);
      if (!oldBudgetLike) return oldData;
      const newBudgetLike = new DynamicBudgetFamily({ ...oldBudgetLike, ...updated });
      const interval = viewDate.getInterval();
      const parentSection = newData.sections.get((newBudgetLike as Category).section_id);
      parentSection?.capacities.forEach((capacity) => {
        const { active_from = new Date(0) } = capacity;
        const newCapacityValue = newBudgetLike.getActiveCapacity(active_from)[interval];
        const oldCapacityValue = oldBudgetLike.getActiveCapacity(active_from)[interval];
        const capacityDiff = newCapacityValue - oldCapacityValue;
        capacity.children_total += capacityDiff;
      });
      const budget_id = parentSection?.budget_id || (newBudgetLike as Section).budget_id;
      const parentBudget = newData.budgets.get(budget_id);
      parentBudget?.capacities.forEach((capacity) => {
        const { active_from = new Date(0) } = capacity;
        const newCapacityValue = newBudgetLike.getActiveCapacity(active_from)[interval];
        const oldCapacityValue = oldBudgetLike.getActiveCapacity(active_from)[interval];
        const capacityDiff = newCapacityValue - oldCapacityValue;
        capacity.children_total += capacityDiff;
        if (type === "category") capacity.grand_children_total += capacityDiff;
      });
      const newDictionary = new DynamicBudgetFamilyDictionary(newData[dictionaryKey] as any);
      newDictionary.set(id, newBudgetLike as any);
      newData[dictionaryKey] = newDictionary;
      return newData as any;
    });
  };

  return save;
};

export const useRemove = () => {
  const { data, setData } = useAppContext();
  const { transactions, categories } = data;

  const remove = async (deleted?: BudgetFamily) => {
    if (!deleted) return;

    const name = deleted.name || "Unnamed";
    const { id, type, dictionaryKey } = deleted;
    const DynamicBudgetFamilyDictionary = getBudgetDictionaryClass(type);

    const queryString = "?" + new URLSearchParams({ id }).toString();

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
