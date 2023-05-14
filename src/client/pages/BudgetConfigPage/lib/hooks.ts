import { call, useAppContext } from "client";
import { Budget, Category, Section } from "common";

export const useEventHandlers = (
  id: string,
  category?: Category,
  section?: Section,
  _budget?: Budget
) => ({
  save: useSave(id, category, section, _budget),
  remove: useRemove(id, category, section, _budget),
});

export const useSave = (
  id: string,
  category?: Category,
  section?: Section,
  _budget?: Budget
) => {
  const { setCategories, setSections, setBudgets } = useAppContext();
  const apiPath = category ? "category" : section ? "section" : "budget";
  const idKey = category ? "category_id" : section ? "section_id" : "budget_id";
  const setDataMap = category ? setCategories : section ? setSections : setBudgets;
  const DataClass = category ? Category : section ? Section : Budget;

  const save = async (updatedData: Partial<Budget | Section | Category>) => {
    const { status } = await call.post(`/api/${apiPath}`, {
      ...updatedData,
      [idKey]: id,
    });

    if (status !== "success") throw new Error(`Failed to update ${apiPath}: ${id}`);

    setDataMap((oldDataMap: any) => {
      const newDataMap = new Map(oldDataMap);
      const oldData = oldDataMap.get(id);
      if (!oldData) return newDataMap;
      const newData = new DataClass({ ...oldData, ...updatedData });
      newDataMap.set(id, newData);
      return newDataMap as any;
    });
  };

  return save;
};

export const useRemove = (
  id: string,
  category?: Category,
  section?: Section,
  _budget?: Budget
) => {
  const { transactions, categories, setCategories, setSections, setBudgets } =
    useAppContext();
  const data = category || section || _budget;
  const name = data?.name || "Unnamed";
  const apiPath = category ? "category" : section ? "section" : "budget";
  const setDataMap = category ? setCategories : section ? setSections : setBudgets;
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
      setDataMap((oldDataMap: any) => {
        const newDataMap = new Map(oldDataMap);
        newDataMap.delete(id);
        return newDataMap as any;
      });
    }
  };

  return remove;
};
