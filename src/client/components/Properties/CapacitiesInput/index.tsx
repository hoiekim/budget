import { Dispatch, SetStateAction, ChangeEventHandler, useRef, useEffect } from "react";
import { BudgetFamily } from "common/models/BudgetFamily";
import {
  Budget,
  Capacity,
  ViewDate,
  currencyCodeToSymbol,
  getDateString,
  getDateTimeString,
  sortCapacities,
} from "common";
import { useAppContext } from "client";
import BudgetDonut from "./BudgetDonut";
import "./index.css";
import CapacityInput from "./CapacityInput";

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
  const { viewDate } = useAppContext();
  const interval = viewDate.getInterval();
  const defaultCapacities = useRef(budgetLike.capacities.map((c) => c.toInputs().capacityInput));

  useEffect(() => {
    defaultCapacities.current = budgetLike.capacities.map((c) => c.toInputs().capacityInput);
  }, [budgetLike]);

  const rows = capacitiesInput.sort(sortCapacities.desc).map((capacity, i) => {
    defaultCapacities.current.sort(sortCapacities.desc);

    const { active_from } = capacity;

    const onChangeDate: ChangeEventHandler<HTMLInputElement> = (e) => {
      const newCapacity = new Capacity(capacity);
      const inputDate = new Date(getDateTimeString(e.target.value));
      const dateHelper = new ViewDate(viewDate.getInterval(), inputDate);
      const newActiveFrom = dateHelper.getDateAsStartDate();
      newCapacity.active_from = newActiveFrom;
      setCapacitiesInput((capacities) => {
        const newCapacities = capacities.map((e) => new Capacity(e));
        newCapacities.splice(i, 1, newCapacity);
        defaultCapacities.current = newCapacities;
        return newCapacities;
      });
    };

    const onChangeAmount: ChangeEventHandler<HTMLInputElement> = (e) => {
      const newCapacity = new Capacity(capacity);
      const value = Math.floor(Math.abs(+e.target.value));
      newCapacity[interval] = value;
      setCapacitiesInput((capacities) => {
        const newCapacities = capacities.map((e) => new Capacity(e));
        newCapacities.splice(i, 1, newCapacity);
        defaultCapacities.current = newCapacities;
        return newCapacities;
      });
    };

    const onDelete = () => {
      if (isSyncedInput || !active_from) return;
      setCapacitiesInput((oldCapacities) => {
        const newCapacities = oldCapacities.map((c) => new Capacity(c));
        newCapacities.splice(i, 1);
        defaultCapacities.current = newCapacities;
        return newCapacities;
      });
    };

    const key = `capacity_${i}_${active_from?.getTime()}`;
    const defaultCapacityValue = capacity[interval];
    const currencyCode = (budgetLike as Budget)["iso_currency_code"] || "USD";

    // If active_from is undefined, it's a default capacity. Default capacity covers all
    // time period backward so `new Date(0)` can be used to refer to the default capacity.
    const date = active_from || new Date(0);
    return (
      <div key={key} className="row">
        <div className="capacityAnalysis">
          <div className="dateLabel">
            <div>
              {active_from ? (
                <>
                  Since&nbsp;
                  <input
                    disabled={isSyncedInput}
                    type="date"
                    defaultValue={getDateString(active_from)}
                    onBlur={onChangeDate}
                  />
                </>
              ) : (
                <>All&nbsp;past</>
              )}
            </div>
            <button disabled={isSyncedInput} onClick={onDelete}>
              Remove&nbsp;This&nbsp;Period
            </button>
          </div>
          {budgetLike.type === "category" ? (
            <div>
              <span>{currencyCodeToSymbol(currencyCode)}</span>
              <CapacityInput
                style={{ width: `${"000,000".length}ch` }}
                disabled={isSyncedInput}
                defaultValue={defaultCapacityValue}
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
              onChangeAmount={onChangeAmount}
            />
          )}
        </div>
      </div>
    );
  });

  const onClickAdd = () => {
    if (isSyncedInput) return;
    setCapacitiesInput((oldCapacities) => {
      const newCapacities = oldCapacities.map((e) => new Capacity(e));
      newCapacities.sort(sortCapacities.asc);

      const latestCapacity = newCapacities[newCapacities.length - 1];
      const dateHelper = new ViewDate(viewDate.getInterval(), latestCapacity.active_from);
      dateHelper.next();
      const active_from = dateHelper.getDateAsStartDate();
      const newCapacityInit: Partial<Capacity> = { ...latestCapacity, active_from };
      delete newCapacityInit.capacity_id;
      const newCapacity = new Capacity(newCapacityInit);
      newCapacity.children_total = latestCapacity.children_total;
      newCapacity.grand_children_total = latestCapacity.grand_children_total;
      newCapacities.push(newCapacity);
      defaultCapacities.current = newCapacities;

      return newCapacities;
    });
  };

  return (
    <div className="CapacitiesInput">
      <div className="row addNew">
        <button disabled={isSyncedInput} onClick={onClickAdd}>
          Add&nbsp;New&nbsp;Period
        </button>
      </div>
      {rows}
    </div>
  );
};

export default CapacitiesInput;
