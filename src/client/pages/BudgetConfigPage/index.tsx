import { useEffect, useState } from "react";
import { Capacity, getDateTimeString } from "common";
import { useAppContext, PATH, useCalculator } from "client";
import { NameInput, Bar, ActionButtons, Properties } from "client/components";
import { BudgetFamily } from "common/models/BudgetFamily";
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
    .map((s) => s && new Date(s)) as (Date | undefined)[];
};

export type BudgetFamilyConfigPageParams = {
  id: string;
};

const BudgetConfigPage = () => {
  const { data, router, viewDate } = useAppContext();
  const { budgets, sections, categories } = data;

  const calculate = useCalculator();

  const { path, params, transition } = router;
  let id: string;
  if (path === PATH.BUDGET_CONFIG) id = params.get("id") || "";
  else id = transition.incomingParams.get("id") || "";

  const defaultBudgetLike = categories.get(id) || sections.get(id) || budgets.get(id);
  const [budgetLike, setBudgetLike] = useState<BudgetFamily | undefined>(defaultBudgetLike);

  useEffect(() => {
    const newBudgetLike = categories.get(id) || sections.get(id) || budgets.get(id);
    setBudgetLike((oldBudgetLike) => newBudgetLike || oldBudgetLike);
  }, [id, categories, sections, budgets]);

  useEffect(() => {
    if (!budgetLike) return;

    const { name, capacities, roll_over, roll_over_start_date: roll_date } = budgetLike;

    const activeCapacity = budgetLike.getActiveCapacity(viewDate.getDate());
    const defaultInputs = activeCapacity.toInputs();
    const defaultCapInput = capacities.map((c) => c.toInputs().capacityInput);

    setNameInput(name);
    setCapacitiesInput(defaultCapInput);
    setIsInfiniteInput(defaultInputs.isInfiniteInput);
    setIsIncomeInput(defaultInputs.isIncomeInput);
    setIsRollOverInput(roll_over);
    setRollDateInput(roll_date || new Date());
  }, [budgetLike, viewDate]);

  const {
    name,
    sorted_amount,
    unsorted_amount,
    roll_over,
    roll_over_start_date: roll_date,
    is_children_synced,
  } = budgetLike || {};

  const activeCapacity = budgetLike?.getActiveCapacity(viewDate.getDate());
  const defaultInputs = activeCapacity?.toInputs();
  const allDates = budgetLike && getAllCapaciyDates(budgetLike);
  const defaultCapInput = allDates?.map(
    (d) => budgetLike?.getActiveCapacity(d || new Date(0)) as Capacity
  );

  const [nameInput, setNameInput] = useState(name);
  const [capacitiesInput, setCapacitiesInput] = useState<Capacity[]>(defaultCapInput || []);
  const [isInfiniteInput, setIsInfiniteInput] = useState(!!defaultInputs?.isInfiniteInput);
  const [isIncomeInput, setIsIncomeInput] = useState(!!defaultInputs?.isIncomeInput);
  const [isRollOverInput, setIsRollOverInput] = useState(!!roll_over);
  const [rollDateInput, setRollDateInput] = useState(roll_date || new Date());
  const [isSyncedInput, setIsSyncedInput] = useState(!!is_children_synced);

  const { save, remove } = useEventHandlers(budgetLike, isSyncedInput);

  if (!budgetLike) return <></>;

  const activeCapInput = activeCapacity!.toInputs().capacityInput;
  const barCapacity = Capacity.fromInputs(activeCapInput, isIncomeInput, isInfiniteInput);
  const barCapacityValue = barCapacity[viewDate.getInterval()];
  const labeledRatio = isInfiniteInput ? undefined : sorted_amount! / barCapacityValue;
  const unlabledRatio = isInfiniteInput ? undefined : unsorted_amount! / barCapacityValue;

  const finishEditing = () => router.back();

  const onComplete = async () => {
    const purgedCapacities = isInfiniteInput ? [new Capacity()] : capacitiesInput;
    const updatedCapacities = purgedCapacities.map((c) => {
      return Capacity.fromInputs(c, isIncomeInput, isInfiniteInput);
    });

    try {
      await save({
        name: nameInput,
        capacities: updatedCapacities,
        roll_over: isRollOverInput,
        roll_over_start_date: rollDateInput,
      });
      if (isRollOverInput) calculate();
    } catch (error: any) {
      console.error(error);
    }

    finishEditing();
  };

  const onDelete = async () => {
    try {
      await remove();
      if (isRollOverInput) calculate();
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
      <Properties
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

export default BudgetConfigPage;
