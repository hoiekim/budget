import { BudgetFamily } from "client/lib/models/BudgetFamily";
import {
  call,
  useAppContext,
  Data,
  getBudgetClass,
  getBudgetDictionaryClass,
  Budget,
  Capacity,
  Category,
  Section,
  CapacityData,
} from "client";
import { LocalDate } from "common";

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
  const { setData, calculations } = useAppContext();
  const { capacityData } = calculations;

  const save = async <T extends BudgetFamily>(original: T, updated: UpdatedBudgetFamily) => {
    const toUpdateList = isSynced
      ? isInfinite
        ? getInfiniteBudgetsToSync(original, updated, isIncome)
        : getLimitedBudgetsToSync(original, updated, capacityData)
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

      return newData;
    });
  };

  return save;
};

const getInfiniteBudgetsToSync = <T extends BudgetFamily>(
  original: T,
  updated: UpdatedBudgetFamily,
  isIncome: boolean,
) => {
  const toUpdateList = new Set<BudgetFamily>();

  const overrideCpacity = Capacity.fromInputs(new Capacity(), isIncome, true);
  const updatedOriginal = original.clone({ ...updated, capacities: [overrideCpacity] });
  toUpdateList.add(updatedOriginal);
  if (original.type !== "category") {
    const { sections: children, categories: grandChildren } = getBudgetsToUpdatePeriod(
      original,
      updated,
    );
    [...children, ...grandChildren].forEach((c) => {
      const isSynced = c.capacities.every((c) => c.isInfinite === true && c.isIncome === isIncome);
      if (!isSynced) {
        c.capacities = [Capacity.fromInputs(new Capacity(), isIncome, true)];
        toUpdateList.add(c);
      }
    });
  }

  return toUpdateList;
};

const getLimitedBudgetsToSync = <T extends BudgetFamily>(
  original: T,
  updated: UpdatedBudgetFamily,
  capacityData: CapacityData,
) => {
  const toUpdateList = new Set<BudgetFamily>();

  const { budget, sections, categories } = getBudgetsToUpdatePeriod(original, updated);
  toUpdateList.add(budget);
  sections.forEach((c) => toUpdateList.add(c));
  categories.forEach((c) => toUpdateList.add(c));

  if (original.type === "budget") {
    for (const capacity of budget.capacities) {
      capacity.month = capacityData.get(capacity.id).grand_children_total;
    }
  }

  if (original.type === "budget" || original.type === "section") {
    for (const section of sections) {
      for (const capacity of section.capacities) {
        capacity.month = capacityData.get(capacity.id).children_total;
      }
    }
  }

  return toUpdateList;
};

const getNonSyncedBudgetsToUpdate = <T extends BudgetFamily>(
  original: T,
  updated: UpdatedBudgetFamily,
  isIncome: boolean,
  isInfinite: boolean,
) => {
  const purgedCapacities = isInfinite ? [new Capacity()] : updated.capacities;
  const updatedCapacities = purgedCapacities.map((c) => {
    return Capacity.fromInputs(c, isIncome, isInfinite);
  });
  const updatedUpdated = { ...updated, capacities: updatedCapacities };
  const { budget, sections, categories } = getBudgetsToUpdatePeriod(original, updatedUpdated);
  return new Set([budget, ...sections, ...categories]);
};

const getBudgetsToUpdatePeriod = <T extends BudgetFamily>(
  original: T,
  updated: UpdatedBudgetFamily,
) => {
  const sections: Section[] = [];
  const categories: Category[] = [];

  const updatedOriginal = original.clone(updated);

  const updateCapacities = (budgetLike: BudgetFamily) => {
    return updatedOriginal.capacities.map(({ active_from }) => {
      const date = active_from && new LocalDate(active_from);
      const activeCapacity = budgetLike.getActiveCapacity(new LocalDate(date || 0));
      const clonedCapacity: Partial<Capacity> = new Capacity(activeCapacity);
      delete clonedCapacity.capacity_id;
      const newCapacity = new Capacity(clonedCapacity);
      newCapacity.active_from = date;
      return newCapacity;
    });
  };

  const budget =
    updatedOriginal?.type === "budget"
      ? (updatedOriginal as unknown as Budget)
      : updatedOriginal.type === "section"
        ? (updatedOriginal.getParent()! as Budget)
        : (updatedOriginal.getParent()?.getParent()! as Budget);

  budget.capacities = updateCapacities(budget);
  budget.getChildren().forEach((c) => {
    let clonedChild = c.clone() as Section;
    if (c.id === updatedOriginal.id) clonedChild = updatedOriginal as unknown as Section;
    clonedChild.capacities = updateCapacities(clonedChild);
    sections.push(clonedChild);
    clonedChild.getChildren().forEach((gc) => {
      let clonedGrandChild = gc.clone() as Category;
      if (gc.id === updatedOriginal.id) clonedGrandChild = updatedOriginal as unknown as Category;
      clonedGrandChild.capacities = updateCapacities(clonedGrandChild);
      categories.push(clonedGrandChild);
    });
  });

  return { budget, sections, categories };
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
        return newData;
      });
    }
  };

  return remove;
};
