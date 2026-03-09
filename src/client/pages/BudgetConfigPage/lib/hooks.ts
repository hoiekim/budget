import { BudgetFamily } from "client/lib/models/BudgetFamily";
import {
  call,
  useAppContext,
  Data,
  getBudgetClass,
  Budget,
  BudgetDictionary,
  Capacity,
  Category,
  CategoryDictionary,
  Section,
  SectionDictionary,
  CapacityData,
  indexedDb,
  StoreName,
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
        indexedDb.save(newBudgetLike as Budget | Section | Category).catch(console.error);
        newData[dictionaryKey].set(id, newBudgetLike as Budget & Section & Category);
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

  // Capture references to original objects BEFORE cloning so we can look up
  // their original capacity IDs in capacityData. getBudgetsToUpdatePeriod
  // deletes capacity_id and generates new UUIDs, which would result in
  // capacityData.get() returning zero defaults for all totals.
  const originalBudget: Budget =
    original.type === "budget"
      ? (original as unknown as Budget)
      : original.type === "section"
        ? (original.getParent()! as Budget)
        : (original.getParent()?.getParent()! as Budget);

  const { budget, sections, categories } = getBudgetsToUpdatePeriod(original, updated);
  toUpdateList.add(budget);
  sections.forEach((c) => toUpdateList.add(c));
  categories.forEach((c) => toUpdateList.add(c));

  if (original.type === "budget") {
    for (const capacity of budget.capacities) {
      const date = capacity.active_from ? new LocalDate(capacity.active_from) : new LocalDate(0);
      const originalCapacity = originalBudget.getActiveCapacity(date);
      capacity.month = capacityData.get(originalCapacity.id).grand_children_total;
    }
  }

  if (original.type === "budget" || original.type === "section") {
    const originalSections = originalBudget.getChildren() as Section[];
    for (const section of sections) {
      const originalSection = originalSections.find((s) => s.id === section.id);
      if (!originalSection) continue;
      for (const capacity of section.capacities) {
        const date = capacity.active_from ? new LocalDate(capacity.active_from) : new LocalDate(0);
        const originalCapacity = originalSection.getActiveCapacity(date);
        capacity.month = capacityData.get(originalCapacity.id).children_total;
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
    const { id, type } = deleted;

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
        const storeName = type === "budget" ? StoreName.budgets : type === "section" ? StoreName.sections : StoreName.categories;
        indexedDb.remove(storeName, id).catch(console.error);
        if (type === "budget") {
          const newDictionary = new BudgetDictionary(newData.budgets);
          newDictionary.delete(id);
          newData.budgets = newDictionary;
        } else if (type === "section") {
          const newDictionary = new SectionDictionary(newData.sections);
          newDictionary.delete(id);
          newData.sections = newDictionary;
        } else {
          const newDictionary = new CategoryDictionary(newData.categories);
          newDictionary.delete(id);
          newData.categories = newDictionary;
        }
        return newData;
      });
    }
  };

  return remove;
};
