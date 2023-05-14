import { useEffect, useState, useMemo } from "react";
import { useAppContext, PATH, useCalculator } from "client";
import {
  NameInput,
  Bar,
  CapacitiesInput,
  ActionButtons,
  Properties,
} from "client/components";
import { Budget, Capacity } from "common";
import { useEventHandlers } from "./lib";

import "./index.css";

export type BudgetLikeConfigPageParams = {
  id: string;
};

const BudgetConfigPage = () => {
  const { budgets, sections, categories, router, viewDate } = useAppContext();

  const calculate = useCalculator();

  const { path, params, transition } = router;
  let id: string;
  if (path === PATH.BUDGET_CONFIG) id = params.get("id") || "";
  else id = transition.incomingParams.get("id") || "";

  const category = categories.get(id);
  const section = sections.get(id) || (category && sections.get(category.section_id));
  const budget = budgets.get(id) || (section && budgets.get(section.budget_id));

  const data = useMemo(() => {
    return category || section || budget || new Budget();
  }, [category, section, budget]);

  const {
    name,
    capacities,
    sorted_amount,
    unsorted_amount,
    roll_over,
    roll_over_start_date: roll_date,
  } = data;

  const activeCapacity = data.getActiveCapacity(viewDate.getDate());
  const defaultInputs = activeCapacity.toInputs();
  const defaultCapInput = capacities.map((c) => c.toInputs().capacityInput);

  const [nameInput, setNameInput] = useState(name);
  const [capacitiesInput, setCapacitiesInput] = useState<Capacity[]>(defaultCapInput);
  const [isInfiniteInput, setIsInfiniteInput] = useState(defaultInputs.isInfiniteInput);
  const [isIncomeInput, setIsIncomeInput] = useState(defaultInputs.isIncomeInput);
  const [isRollOverInput, setIsRollOverInput] = useState(roll_over);
  const [rollDateInput, setRollDateInput] = useState(roll_date || new Date());

  useEffect(() => {
    if (!data) return;

    const { name, capacities, roll_over, roll_over_start_date: roll_date } = data;

    const activeCapacity = data.getActiveCapacity(viewDate.getDate());
    const defaultInputs = activeCapacity.toInputs();
    const defaultCapInput = capacities.map((c) => c.toInputs().capacityInput);

    setNameInput(name);
    setCapacitiesInput(defaultCapInput);
    setIsInfiniteInput(defaultInputs.isInfiniteInput);
    setIsIncomeInput(defaultInputs.isIncomeInput);
    setIsRollOverInput(roll_over);
    setRollDateInput(roll_date || new Date());
  }, [data, viewDate]);

  const { save, remove } = useEventHandlers(id, category, section, budget);

  const iso_currency_code = budget?.iso_currency_code || "USD";
  const activeCapInput = activeCapacity.toInputs().capacityInput;
  const barCapacity = Capacity.fromInputs(activeCapInput, isIncomeInput, isInfiniteInput);
  const barCapacityValue = barCapacity[viewDate.getInterval()];
  const labeledRatio = isInfiniteInput ? undefined : sorted_amount / barCapacityValue;
  const unlabledRatio = isInfiniteInput ? undefined : unsorted_amount / barCapacityValue;

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

  if (!budget) return <></>;

  return (
    <div className="BudgetConfigPage">
      <div className="title">
        <NameInput defaultValue={name} onChange={(e) => setNameInput(e.target.value)} />
      </div>
      <div className="statusBarWithText">
        <Bar ratio={labeledRatio} unlabledRatio={unlabledRatio} noAlert={isIncomeInput} />
        <CapacitiesInput
          isInfiniteInput={isInfiniteInput}
          currencyCode={iso_currency_code}
          defaultCapacities={capacities.map((c) => c.toInputs().capacityInput)}
          capacitiesInput={capacitiesInput}
          setCapacitiesInput={setCapacitiesInput}
        />
      </div>
      <Properties
        isIncomeInput={isIncomeInput}
        setIsIncomeInput={setIsIncomeInput}
        isInfiniteInput={isInfiniteInput}
        setIsInfiniteInput={setIsInfiniteInput}
        isRollOverInput={isRollOverInput}
        setIsRollOverInput={setIsRollOverInput}
        rollOverStartDateInput={rollDateInput}
        setRollOverStartDateInput={setRollDateInput}
      />
      <ActionButtons
        onComplete={onComplete}
        onCancel={finishEditing}
        onDelete={onDelete}
      />
    </div>
  );
};

export default BudgetConfigPage;
