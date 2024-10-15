import {
  Capacity,
  Data,
  Interval,
  getBudgetClass,
  getBudgetDictionaryClass,
  getDateTimeString,
} from "common";
import { BudgetFamily } from "common/models/BudgetFamily";
import { calculatorLambda, call, useAppContext } from "client";

export const useEventHandlers = (isSynced: boolean, isIncome: boolean, isInfinite: boolean) => {
  return {
    save: useSave(isSynced, isIncome, isInfinite),
    remove: useRemove(),
  };
};

interface UpdatedBudgetFamily {
  name?: string;
  capacities: Capacity[];
  roll_over: boolean;
  roll_over_start_date: Date;
}

export const useSave = (isSynced: boolean, isIncome: boolean, isInfinite: boolean) => {
  const { setData, viewDate } = useAppContext();
  const interval = viewDate.getInterval();

  const save = async <T extends BudgetFamily>(original: T, updated: UpdatedBudgetFamily) => {
    const toUpdateList = isSynced
      ? isInfinite
        ? getInfiniteBudgetsToSync(original, updated, isIncome)
        : getLimitedBudgetsToSync(original, updated, interval)
      : getNonSyncedBudgetsToUpdate(original, updated, isIncome, isInfinite);

    const iterator = toUpdateList.values();
    let current = iterator.next();
    while (!current.done) {
      const budgetLike = current.value;
      const { id, type } = budgetLike;
      const { status } = await call.post(`/api/${type}`, budgetLike);
      if (status !== "success") throw new Error(`Failed to update ${type}: ${id}`);
      current = iterator.next();
    }

    setData((oldData) => {
      const newData = new Data(oldData);

      const iterator = toUpdateList.values();
      let current = iterator.next();
      while (!current.done) {
        const budgetLike = current.value;
        const { id, type, dictionaryKey } = budgetLike;
        if (!oldData[dictionaryKey].has(id)) return oldData;
        const DynamicBudgetFamily = getBudgetClass(type);
        const newBudgetLike = new DynamicBudgetFamily(budgetLike);
        newData[dictionaryKey].set(id, newBudgetLike as any);
        current = iterator.next();
      }

      const { budgets, sections, categories } = calculatorLambda(newData, viewDate);
      newData.budgets = budgets;
      newData.sections = sections;
      newData.categories = categories;
      return newData;
    });
  };

  return save;
};

const getInfiniteBudgetsToSync = <T extends BudgetFamily>(
  original: T,
  updated: UpdatedBudgetFamily,
  isIncome: boolean
) => {
  const toUpdateList = new Set<BudgetFamily>();

  const updatedCapacities = [Capacity.fromInputs(new Capacity(), isIncome, true)];
  const clonedOriginal = original.clone({ ...updated, capacities: updatedCapacities });
  toUpdateList.add(clonedOriginal);
  if (original.type !== "category") {
    const { children, grandChildren } = getChildrenWithUpdatedCapacityPeriod(original, updated);
    [...children, ...grandChildren].forEach((c) => {
      const isSynced = c.capacities.every((c) => c.isInfinite === true && c.isIncome === isIncome);
      if (!isSynced) {
        const clonedChild = c.clone({ capacities: updatedCapacities });
        toUpdateList.add(clonedChild);
      }
    });
  }

  return toUpdateList;
};

const getLimitedBudgetsToSync = <T extends BudgetFamily>(
  original: T,
  updated: UpdatedBudgetFamily,
  interval: Interval
) => {
  const toUpdateList = new Set<BudgetFamily>();
  const syncedCapacities = original.capacities.map((c) => {
    const newCapacity = new Capacity(c);
    if (original.type !== "category")
      newCapacity[interval] = c.grand_children_total || c.children_total;
    return newCapacity;
  });
  const clonedOriginal = original.clone({ ...updated, capacities: syncedCapacities });

  toUpdateList.add(clonedOriginal);

  if (original.type === "budget") {
    const { children } = getChildrenWithUpdatedCapacityPeriod(original, updated);
    for (const child of children) {
      for (const capacity of updated.capacities) {
        const capacityAmount = capacity[interval];
        const isChildrenTied = capacityAmount === capacity.children_total;
        const isGrandChildrenTied = capacityAmount === capacity.grand_children_total;
        const isSynced = isChildrenTied && isGrandChildrenTied;
        if (isSynced) continue;
        const childCapacity = child.getActiveCapacity(capacity.active_from || new Date(0));
        if (childCapacity[interval] !== childCapacity.children_total) {
          childCapacity[interval] = childCapacity.children_total;
          toUpdateList.add(child);
        }
      }
    }
  }
  return toUpdateList;
};

const getNonSyncedBudgetsToUpdate = <T extends BudgetFamily>(
  original: T,
  updated: UpdatedBudgetFamily,
  isIncome: boolean,
  isInfinite: boolean
) => {
  const purgedCapacities = isInfinite ? [new Capacity()] : updated.capacities;
  const updatedCapacities = purgedCapacities.map((c) => {
    return Capacity.fromInputs(c, isIncome, isInfinite);
  });

  const clonedOriginal = original.clone({ ...updated, capacities: updatedCapacities });
  const { children, grandChildren } = getChildrenWithUpdatedCapacityPeriod(original, updated);
  return new Set([clonedOriginal, ...children, ...grandChildren]);
};

const getChildrenWithUpdatedCapacityPeriod = <T extends BudgetFamily>(
  original: T,
  updated: UpdatedBudgetFamily
) => {
  const children: BudgetFamily[] = [];
  const grandChildren: BudgetFamily[] = [];

  const clonedOriginal = original.clone(updated);

  const uniqueDates = new Set<string | undefined>();
  const addActiveFromDate = ({ active_from }: Capacity) => {
    uniqueDates.add(active_from && getDateTimeString(active_from));
  };
  const fillCapacities = (budgetLike: BudgetFamily) => {
    return Array.from(uniqueDates).map((d) => {
      const date = new Date(d || 0);
      const activeCapacity = budgetLike.getActiveCapacity(new Date(d || 0));
      const newCapacity = new Capacity(activeCapacity);
      newCapacity.active_from = d ? date : undefined;
      return newCapacity;
    });
  };

  clonedOriginal.capacities.forEach(addActiveFromDate);
  clonedOriginal.getChildren().forEach((c) => {
    c.capacities.forEach(addActiveFromDate);
    c.getChildren().forEach((gc) => {
      gc.capacities.forEach(addActiveFromDate);
    });
  });

  clonedOriginal.capacities = fillCapacities(clonedOriginal);
  clonedOriginal.getChildren().forEach((c) => {
    const clonedChild = c.clone();
    clonedChild.capacities = fillCapacities(clonedChild);
    children.push(clonedChild);
    clonedChild.getChildren().forEach((gc) => {
      const clonedGrandChild = gc.clone();
      clonedGrandChild.capacities = fillCapacities(clonedGrandChild);
      grandChildren.push(clonedGrandChild);
    });
  });

  return { children, grandChildren };
};

export const useRemove = () => {
  const { data, setData, viewDate } = useAppContext();
  const { transactions, categories } = data;

  const remove = async (deleted?: BudgetFamily) => {
    if (!deleted) return;

    const name = deleted.name || "Unnamed";
    const { id, type, dictionaryKey } = deleted;
    const DynamicBudgetFamilyDictionary = getBudgetDictionaryClass(type);

    const queryString = "?" + new URLSearchParams({ id }).toString();

    let shouldConfirm = false;

    if (type === "category") {
      const iterator = transactions.values();
      let current = iterator.next();
      while (!current.done) {
        const transaction = current.value;
        if (transaction.label.category_id === id) {
          shouldConfirm = true;
          break;
        }
        current = iterator.next();
      }
    } else if (type === "section") {
      const iterator = categories.values();
      let current = iterator.next();
      while (!current.done) {
        const category = current.value;
        if (category.section_id === id) {
          shouldConfirm = true;
          break;
        }
        current = iterator.next();
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
        const { budgets, sections, categories } = calculatorLambda(newData, viewDate);
        newData.budgets = budgets;
        newData.sections = sections;
        newData.categories = categories;
        return newData;
      });
    }
  };

  return remove;
};
