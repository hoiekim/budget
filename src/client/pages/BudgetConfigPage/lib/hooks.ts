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
  if (original.type !== "category") overrideCpacity.is_synced = true;
  const updatedOriginal = original.clone({ ...updated, capacities: [overrideCpacity] });
  toUpdateList.add(updatedOriginal);
  if (original.type !== "category") {
    const { sections: children, categories: grandChildren } = getBudgetsToUpdatePeriod(
      original,
      updated,
    );
    // The previous skip-check `every(c => c.isInfinite && c.isIncome === isIncome)`
    // read the `isInfinite`/`isIncome` getters which look at the stored
    // `.month` — that's the stale advisory cache for is_synced rows.
    // Replaced with an `is_synced`-aware skip: a section that's already
    // flagged synced AND has every capacity stored as `±MAX_FLOAT` with
    // the right sign is considered up-to-date. Categories (leaves) still
    // use the simpler stored-month check since they never carry the flag.
    children.forEach((c) => {
      const isAlreadyInfiniteSynced = c.capacities.every(
        (cap) => cap.is_synced && cap.isInfinite && cap.isIncome === isIncome,
      );
      if (!isAlreadyInfiniteSynced) {
        const newCap = Capacity.fromInputs(new Capacity(), isIncome, true);
        newCap.is_synced = true;
        c.capacities = [newCap];
        toUpdateList.add(c);
      }
    });
    grandChildren.forEach((c) => {
      // Categories are leaves — is_synced never applies. The skip check
      // is the pre-flag semantic verbatim.
      const isAlreadyInfinite = c.capacities.every(
        (cap) => cap.isInfinite && cap.isIncome === isIncome,
      );
      if (!isAlreadyInfinite) {
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
  _capacityData: CapacityData,
) => {
  const toUpdateList = new Set<BudgetFamily>();

  const { budget, sections, categories } = getBudgetsToUpdatePeriod(original, updated);
  toUpdateList.add(budget);
  sections.forEach((c) => toUpdateList.add(c));
  categories.forEach((c) => toUpdateList.add(c));

  // Mark budget + section capacities as "synced with children". The stored
  // `month` is left as-is (advisory cache); readers must derive the
  // displayed amount via Capacity.getActiveAmount, which sums the same
  // period's amounts from the entity's children. This replaces the
  // previous design where the FE summed children via `capacityData` and
  // persisted the result into `month` — a frontend math bug could then
  // corrupt the saved sum. Mark-only-and-derive eliminates that class.
  if (original.type === "budget") {
    for (const capacity of budget.capacities) {
      capacity.is_synced = true;
    }
  }

  if (original.type === "budget" || original.type === "section") {
    for (const section of sections) {
      for (const capacity of section.capacities) {
        capacity.is_synced = true;
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
    const capacity = Capacity.fromInputs(c, isIncome, isInfinite);
    // User is committing concrete amounts on this entity; no derivation
    // from children. Clear is_synced explicitly so a previously-synced
    // capacity row flips back to authoritative-amount mode.
    capacity.is_synced = false;
    return capacity;
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
