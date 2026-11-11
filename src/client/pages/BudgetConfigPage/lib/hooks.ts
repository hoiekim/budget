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

    // Aggregate the entities whose POSTs succeeded, then write them to the
    // store in ONE setData call: each setData re-renders the data consumers
    // and schedules the debounced full recalculation (Utility), so one
    // call per entity in the loop repeats that work for every entity in
    // the family. The single write still happens even when a later POST
    // fails — the entities that already committed stay visible instead of
    // vanishing until the next full /api/budgets sync (fixes #810) — and
    // the throw still surfaces the failure for the remainder.
    const committed: BudgetFamily[] = [];
    let failure: Error | undefined;
    const iterator = toUpdateList.values();
    let current = iterator.next();
    while (!current.done) {
      const budgetLike = current.value;
      const { id, type } = budgetLike;
      const { status, message } = await call.post(`/api/${type}`, budgetLike);
      if (status !== "success") {
        failure = new Error(message || `Failed to update ${type}: ${id}`);
        break;
      }
      committed.push(budgetLike);
      current = iterator.next();
    }

    if (committed.length > 0) {
      setData((oldData) => {
        const newData = new Data(oldData);
        for (const budgetLike of committed) {
          const { id, type, dictionaryKey } = budgetLike;
          if (!oldData[dictionaryKey].has(id)) continue;
          const DynamicBudgetFamily = getBudgetClass(type);
          const newBudgetLike = new DynamicBudgetFamily(budgetLike);
          indexedDb.save(newBudgetLike as Budget | Section | Category).catch(console.error);
          newData[dictionaryKey].set(id, newBudgetLike as Budget & Section & Category);
        }
        return newData;
      });
    }
    if (failure) throw failure;
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

  // Mark ONLY the toggled entity. The infinite path does not cascade:
  // an unsynced infinite section already reads ±MAX_FLOAT from its stored
  // month, so the toggled budget still sums to unlimited when a child is
  // infinite, and a section the user never toggled keeps its stored
  // amount. (The limited sync path does cascade onto sections — see
  // getLimitedBudgetsToSync — because a synced budget must sum its
  // sections' derived amounts, not their stored ones.)
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

  // Mark the toggled entity — and, for a budget, its sections — as "synced
  // with children". The stored `month` is left as-is (advisory cache);
  // readers must derive the displayed amount via Capacity.getActiveAmount,
  // which sums the same period's amounts from the entity's children. This
  // replaces the previous design where the FE summed children via
  // `capacityData` and persisted the result into `month` — a frontend math
  // bug could then corrupt the saved sum. Mark-only-and-derive eliminates
  // that class.
  //
  // A budget toggle cascades: the budget derives from its sections, so the
  // sections must derive from their categories too, or the budget would
  // sum the sections' stored amounts instead of their live ones. A section
  // toggle marks only that section — its children are categories, which
  // never carry the flag. A synced section with no categories falls back
  // to its stored amount in getActiveAmount, so the cascade can no longer
  // zero out a childless section.
  if (original.type === "budget") {
    for (const capacity of budget.capacities) {
      capacity.is_synced = true;
    }
    for (const section of sections) {
      for (const capacity of section.capacities) {
        capacity.is_synced = true;
      }
    }
  } else if (original.type === "section") {
    const section = sections.find((s) => s.id === original.id);
    if (section) {
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

  const budget =
    updatedOriginal?.type === "budget"
      ? (updatedOriginal as unknown as Budget)
      : updatedOriginal.type === "section"
        ? (updatedOriginal.getParent()! as Budget)
        : (updatedOriginal.getParent()?.getParent()! as Budget);

  // The period list belongs to the family, not to the entity being edited.
  // Editing the budget itself redefines the periods, so the edited list
  // rules; saving a child re-derives against the family's existing
  // boundaries instead. Deriving from the edited child collapsed the
  // whole family to the child's periods — a newly added section or
  // category always has exactly one capacity — deleting every other
  // period on the budget and every sibling with it.
  const periodDates =
    updatedOriginal.type === "budget"
      ? updatedOriginal.capacities.map((c) => c.active_from)
      : budget.capacities.map((c) => c.active_from);

  const updateCapacities = (budgetLike: BudgetFamily) => {
    return periodDates.map((active_from) => {
      const date = active_from && new LocalDate(active_from);
      const activeCapacity = budgetLike.getActiveCapacity(new LocalDate(date || 0));
      const clonedCapacity: Partial<Capacity> = new Capacity(activeCapacity);
      // Keep the stored row's id when this period already has a row for
      // this entity: a child save must not churn the family's capacity
      // ids. A period the entity doesn't have yet mints a fresh id — the
      // stored row only covers it by roll-forward, so the period's row is
      // new.
      const samePeriod =
        new LocalDate(activeCapacity.active_from || 0).getTime() ===
        new LocalDate(date || 0).getTime();
      if (!samePeriod) delete clonedCapacity.capacity_id;
      const newCapacity = new Capacity(clonedCapacity);
      newCapacity.active_from = date;
      return newCapacity;
    });
  };

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
    if (!deleted) return false;

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
      if (!confirm) return false;
    }

    const { status, message } = await call.delete(`/api/${type}` + queryString);
    if (status !== "success") {
      throw new Error(message || `Failed to delete ${type}: ${id}`);
    }
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
    return true;
  };

  return remove;
};
