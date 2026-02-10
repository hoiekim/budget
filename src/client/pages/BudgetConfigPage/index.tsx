import { useEffect, useState } from "react";
import { getDateTimeString, LocalDate } from "common";
import { Capacity, useAppContext, PATH } from "client";
import { NameInput, Bar, ActionButtons, BudgetProperties } from "client/components";
import { BudgetFamily } from "client/lib/models/BudgetFamily";
import { useEventHandlers } from "./lib";

import "./index.css";

const getAllCapaciyDates = (budgetLike: BudgetFamily) => {
  const uniqueDates = new Set<string | undefined>();
  const addActiveFromDate = ({ active_from }: Capacity) => {
    uniqueDates.add(active_from && getDateTimeString(active_from));
  };
  budgetLike.capacities.forEach(addActiveFromDate);
  budgetLike.getChildren().forEach((child) => {
    child.capacities.forEach(addActiveFromDate);
    child.getChildren().forEach((grandChild) => {
      grandChild.capacities.forEach(addActiveFromDate);
    });
  });
  return Array.from(uniqueDates)
    .sort((a, b) => new Date(b || 0).getTime() - new Date(a || 0).getTime())
    .map((s) => s && new LocalDate(s)) as (Date | undefined)[];
};

export type BudgetFamilyConfigPageParams = {
  id: string;
};

export const BudgetConfigPage = () => {
  const { data, calculations, router, viewDate } = useAppContext();
  const { budgetData, capacityData } = calculations;
  const interval = viewDate.getInterval();
  const date = viewDate.getEndDate();
  const { budgets, sections, categories } = data;

  const { path, params, transition } = router;
  let id: string;
  if (path === PATH.BUDGET_CONFIG) {
    id = params.get("category_id") || params.get("section_id") || params.get("budget_id") || "";
  } else {
    id =
      transition.incomingParams.get("category_id") ||
      transition.incomingParams.get("section_id") ||
      transition.incomingParams.get("budget_id") ||
      "";
  }

  const defaultBudgetLike = categories.get(id) || sections.get(id) || budgets.get(id);
  const [budgetLike, setBudgetLike] = useState<BudgetFamily | undefined>(defaultBudgetLike);

  useEffect(() => {
    const newBudgetLike = categories.get(id) || sections.get(id) || budgets.get(id);
    setBudgetLike((oldBudgetLike) => newBudgetLike?.clone() || oldBudgetLike);
  }, [id, categories, sections, budgets]);

  useEffect(() => {
    if (!budgetLike) return;

    const { name, roll_over, roll_over_start_date: roll_date } = budgetLike;

    const activeCapacity = budgetLike.getActiveCapacity(viewDate.getEndDate());
    const defaultInputs = activeCapacity.toInputs();
    const allDates = budgetLike && getAllCapaciyDates(budgetLike);
    const defaultCapInput = allDates?.map((d) => {
      const activeCapacity = budgetLike?.getActiveCapacity(d || new Date(0));
      const cloned = new Capacity(activeCapacity);
      if (d && (!cloned.active_from || d < cloned.active_from)) {
        cloned.active_from = new Date(d);
      }
      return cloned;
    });
    const defaultIsSyncInput =
      budgetLike.type !== "category" && !!budgetLike?.isChildrenSynced(capacityData);

    setNameInput(name);
    setCapacitiesInput(defaultCapInput);
    setIsInfiniteInput(defaultInputs.isInfiniteInput);
    setIsIncomeInput(defaultInputs.isIncomeInput);
    setIsRollOverInput(roll_over);
    setRollDateInput(roll_date || new Date());
    setIsSyncedInput(defaultIsSyncInput);
  }, [budgetLike, capacityData, viewDate]);

  const { sorted_amount, unsorted_amount } = budgetData.get(id, date);
  const { name, roll_over, roll_over_start_date: roll_date } = budgetLike || {};

  const activeCapacity = budgetLike?.getActiveCapacity(date);
  const defaultInputs = activeCapacity?.toInputs();
  const allDates = budgetLike && getAllCapaciyDates(budgetLike);
  const defaultCapInput =
    budgetLike && allDates?.map((d) => budgetLike.getActiveCapacity(d || new Date(0)));
  const defaultIsSyncInput =
    budgetLike?.type !== "category" && !!budgetLike?.isChildrenSynced(capacityData);

  const [nameInput, setNameInput] = useState(name);
  const [capacitiesInput, setCapacitiesInput] = useState<Capacity[]>(defaultCapInput || []);
  const [isInfiniteInput, setIsInfiniteInput] = useState(!!defaultInputs?.isInfiniteInput);
  const [isIncomeInput, setIsIncomeInput] = useState(!!defaultInputs?.isIncomeInput);
  const [isRollOverInput, setIsRollOverInput] = useState(!!roll_over);
  const [rollDateInput, setRollDateInput] = useState(roll_date || new Date());
  const [isSyncedInput, setIsSyncedInput] = useState(defaultIsSyncInput);

  const { save, remove } = useEventHandlers(isSyncedInput, isIncomeInput, isInfiniteInput);

  if (!budgetLike) return <></>;

  const activeCapInput = activeCapacity!.toInputs().capacityInput;
  const barCapacity = Capacity.fromInputs(activeCapInput, isIncomeInput, isInfiniteInput);
  const barCapacityValue = barCapacity[interval];
  const labeledRatio = isInfiniteInput ? undefined : sorted_amount! / barCapacityValue;
  const unlabledRatio = isInfiniteInput ? undefined : unsorted_amount! / barCapacityValue;

  const finishEditing = () => router.back();

  const onComplete = async () => {
    try {
      await save(budgetLike, {
        name: nameInput,
        capacities: capacitiesInput,
        roll_over: isRollOverInput,
        roll_over_start_date: rollDateInput,
      });
    } catch (error: any) {
      console.error(error);
    }

    router.back();
  };

  const onDelete = async () => {
    try {
      await remove(budgetLike);
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
        <Bar
          memoryKey={id}
          ratio={labeledRatio}
          unlabeledRatio={unlabledRatio}
          noAlert={isIncomeInput}
        />
      </div>
      <BudgetProperties
        budgetLike={budgetLike}
        isIncomeInput={isIncomeInput}
        setIsIncomeInput={setIsIncomeInput}
        isInfiniteInput={isInfiniteInput}
        setIsInfiniteInput={setIsInfiniteInput}
        isRollOverInput={isRollOverInput}
        setIsRollOverInput={setIsRollOverInput}
        rollOverStartDateInput={rollDateInput}
        setRollOverStartDateInput={setRollDateInput}
        capacitiesInput={capacitiesInput}
        setCapacitiesInput={setCapacitiesInput}
        isSyncedInput={isSyncedInput}
        setIsSyncedInput={setIsSyncedInput}
      />
      <ActionButtons onComplete={onComplete} onCancel={finishEditing} onDelete={onDelete} />
    </div>
  );
};
