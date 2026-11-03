import { Dispatch, SetStateAction, ChangeEventHandler, useRef, useEffect } from "react";
import { LocalDate, ViewDate, currencyCodeToSymbol, getDateString } from "common";
import { Budget, Capacity, CapacityData, sortCapacities, useAppContext } from "client";
import { BudgetFamily } from "client/lib/models/BudgetFamily";
import { CapacityInput, ButtonRow, Row } from "client/components";
import BudgetDonut from "./BudgetDonut";
import "./index.css";

interface Props {
  budgetLike: BudgetFamily;
  capacitiesInput: Capacity[];
  setCapacitiesInput: Dispatch<SetStateAction<Capacity[]>>;
  isSyncedInput: boolean;
}

const CapacitiesInput = ({
  budgetLike,
  capacitiesInput,
  setCapacitiesInput,
  isSyncedInput,
}: Props) => {
  const { viewDate, calculate } = useAppContext();
  const interval = "month";
  const defaultCapacities = useRef(budgetLike.capacities.map((c) => c.toInputs().capacityInput));

  useEffect(() => {
    defaultCapacities.current = budgetLike.capacities.map((c) => c.toInputs().capacityInput);
  }, [budgetLike]);

  const rows = [...capacitiesInput].sort(sortCapacities.desc).map((capacity) => {
    defaultCapacities.current.sort(sortCapacities.desc);

    const { active_from } = capacity;

    const onChangeDate: ChangeEventHandler<HTMLInputElement> = (e) => {
      const newCapacity = new Capacity(capacity);
      const inputDate = new LocalDate(e.target.value);
      const dateHelper = new ViewDate(viewDate.getInterval(), inputDate);
      const newActiveFrom = dateHelper.getStartDate();
      newCapacity.active_from = newActiveFrom;
      // Match by id: rows are display-sorted, so a row's index is not its index in state.
      const newCapacities = capacitiesInput.map((c) =>
        c.id === capacity.id ? newCapacity : new Capacity(c),
      );
      setCapacitiesInput(newCapacities);
      defaultCapacities.current = newCapacities;
    };

    // The capacity's sign is owned by the Expense/Income radio, not the
    // field — so the input normalizes (floor + abs) on blur and this
    // handler takes the payload as-is, instead of re-deriving the rule
    // in a second place that could drift from the displayed string.
    const onChangeAmount: ChangeEventHandler<HTMLInputElement> = (e) => {
      const newCapacity = new Capacity(capacity);
      const value = +e.target.value;
      newCapacity.month = value;
      const newCapacities = capacitiesInput.map((c) =>
        c.id === capacity.id ? newCapacity : new Capacity(c),
      );
      setCapacitiesInput(newCapacities);
      defaultCapacities.current = newCapacities;
    };

    const onDelete = () => {
      if (!active_from) return;
      const newCapacities = capacitiesInput
        .filter((c) => c.id !== capacity.id)
        .map((c) => new Capacity(c));
      setCapacitiesInput(newCapacities);
      defaultCapacities.current = newCapacities;
    };

    const key = `capacity_${capacity.id}`;
    const defaultCapacityValue = capacity.toInputs().capacityInput[interval];
    const currencyCode = (budgetLike as Budget)["iso_currency_code"] || "USD";

    // If active_from is undefined, it's a default capacity. Default capacity covers all
    // time period backward so `new Date(0)` can be used to refer to the default capacity.
    const date = active_from || new Date(0);
    return (
      <Row key={key}>
        <div className="capacityAnalysis">
          <div className="dateLabel">
            <div>
              {active_from ? (
                <>
                  Since&nbsp;
                  <input
                    type="date"
                    defaultValue={getDateString(active_from)}
                    onBlur={onChangeDate}
                    aria-label="Capacity active from date"
                  />
                </>
              ) : (
                <>All&nbsp;past</>
              )}
            </div>
            <button onClick={onDelete}>Remove</button>
          </div>
          {budgetLike.type === "category" ? (
            <div>
              <span>{currencyCodeToSymbol(currencyCode)}</span>
              <CapacityInput
                style={{ width: `${"000,000".length}ch` }}
                disabled={isSyncedInput}
                defaultValue={defaultCapacityValue}
                normalize={(n) => Math.floor(Math.abs(n))}
                onBlur={onChangeAmount}
              />
            </div>
          ) : (
            <BudgetDonut
              budgetLike={budgetLike}
              date={date}
              isSyncedInput={isSyncedInput}
              capacityInput={capacity}
              defaultCapacityInput={capacity}
              normalize={(n) => Math.floor(Math.abs(n))}
              onChangeAmount={onChangeAmount}
            />
          )}
        </div>
      </Row>
    );
  });

  const onClickAdd = () => {
    // Side effects hoisted out of the updater: it runs during render, and
    // the cache write is an AppContext setState ("Cannot update a component").
    const newCapacities = capacitiesInput.map((e) => new Capacity(e));
    newCapacities.sort(sortCapacities.asc);

    const latestCapacity = newCapacities[newCapacities.length - 1];
    const dateHelper = new ViewDate(viewDate.getInterval(), latestCapacity.active_from);
    dateHelper.next();
    const active_from = dateHelper.getStartDate();
    const newCapacityInit: Partial<Capacity> = { ...latestCapacity, active_from };
    delete newCapacityInit.capacity_id;
    const newCapacity = new Capacity(newCapacityInit);

    newCapacities.push(newCapacity);
    setCapacitiesInput(newCapacities);
    defaultCapacities.current = newCapacities;

    // Directly update cached capacityData to trigger React re-render for other components.
    // Uses calculate.cache.capacityData() to update the cache without re-running calculation.
    calculate.cache.capacityData((data) => {
      const newData = new CapacityData(data);
      const newCapacitySummary = newData.get(newCapacity.id);
      const latestCapacitySummary = data.get(latestCapacity.id);
      if (latestCapacitySummary) {
        newCapacitySummary.children_total = latestCapacitySummary.children_total;
        newCapacitySummary.grand_children_total = latestCapacitySummary.grand_children_total;
      }
      return newData;
    });
  };

  return (
    <div className="CapacitiesInput">
      <ButtonRow onClick={onClickAdd}>Add&nbsp;New&nbsp;Period</ButtonRow>
      {rows}
    </div>
  );
};

export default CapacitiesInput;
