import { ChangeEventHandler, Dispatch, SetStateAction } from "react";
import { Capacity, ViewDate, getDateString, getDateTimeString } from "common";
import { BudgetLike } from "common/models/BudgetLike";
import { useAppContext } from "client";
import ToggleInput from "./ToggleInput";
import RadioInputs from "./RadioInputs";
import BudgetDonut from "./BudgetDonut";
import "./index.css";

const getAllCapaciyDates = (budgetLike: BudgetLike) => {
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

interface Props {
  budgetLike: BudgetLike;
  isIncomeInput: boolean;
  setIsIncomeInput: Dispatch<SetStateAction<boolean>>;
  isInfiniteInput: boolean;
  setIsInfiniteInput: Dispatch<SetStateAction<boolean>>;
  isRollOverInput: boolean;
  setIsRollOverInput: Dispatch<SetStateAction<boolean>>;
  rollOverStartDateInput: Date;
  setRollOverStartDateInput: Dispatch<SetStateAction<Date>>;
  isSyncedInput: boolean;
  setIsSyncedInput: Dispatch<SetStateAction<boolean>>;
}

const Properties = ({
  budgetLike,
  isIncomeInput,
  setIsIncomeInput,
  isInfiniteInput,
  setIsInfiniteInput,
  isRollOverInput,
  setIsRollOverInput,
  rollOverStartDateInput,
  setRollOverStartDateInput,
  isSyncedInput,
  setIsSyncedInput,
}: Props) => {
  const { viewDate } = useAppContext();

  const onChangeSync: ChangeEventHandler<HTMLInputElement> = (e) => {
    // TODO
    // const newValue = e.target.checked;
    // setIsSyncedInput(newValue);
    // if (newValue) {
    //   // TODO: Calculate
    // }
  };

  const onChangeRollDate: ChangeEventHandler<HTMLInputElement> = (e) => {
    const inputDate = new Date(getDateTimeString(e.target.value));
    const dateHelper = new ViewDate(viewDate.getInterval(), inputDate);
    const newRollDate = dateHelper.getDateAsStartDate();
    setRollOverStartDateInput(newRollDate);
  };

  const allCapacityDates = getAllCapaciyDates(budgetLike);
  const capacityRows = allCapacityDates.map((d, i) => {
    // If date is undefined, it's a default capacity. Default capacity covers all time period
    // backward so `new Date(0)` can be used to retrieve the default capacity.
    const date = d || new Date(0);
    const endDate = i > 0 ? allCapacityDates[i - 1] : undefined;
    return (
      <div key={i} className="row">
        <div className="capacityAnalysis">
          <div className="dateLabel">
            {d ? getDateString(date) : <>All&nbsp;past</>}
            {endDate && <>&nbsp;-&nbsp;{getDateString(endDate)}</>}
          </div>
          <BudgetDonut budgetLike={budgetLike} date={date} />
        </div>
      </div>
    );
  });

  return (
    <div className="Properties">
      <div className="property">
        <RadioInputs
          disabled={isSyncedInput}
          checkedOptionId={isIncomeInput ? "income" : "expense"}
          name="incomeOrExpense"
          options={[
            { id: "expense", label: "Expense" },
            { id: "income", label: "Income" },
          ]}
          onChange={(e) => setIsIncomeInput(e.target.id === "income")}
        />
      </div>
      <div className="property">
        <div className="row">
          <span>Limited budget</span>
          <ToggleInput
            disabled={isSyncedInput}
            checked={!isInfiniteInput}
            onChange={(e) => setIsInfiniteInput(!e.target.checked)}
          />
        </div>
      </div>
      <div className="property">
        {!isInfiniteInput && (
          <>
            <div className="row">
              <span>Rolls over to the next period</span>
              <ToggleInput
                disabled={isSyncedInput}
                checked={isRollOverInput}
                onChange={(e) => setIsRollOverInput(e.target.checked)}
              />
            </div>
            {isRollOverInput && (
              <div className="row">
                <span>Rolls over from&nbsp;</span>
                <input
                  disabled={isSyncedInput}
                  type="date"
                  value={getDateString(rollOverStartDateInput)}
                  onChange={onChangeRollDate}
                />
              </div>
            )}
          </>
        )}
      </div>
      <div className="property">
        <div className="row">
          <span>Lock & Sync all budget family</span>
          <ToggleInput checked={isSyncedInput} onChange={onChangeSync} />
        </div>
        {capacityRows}
      </div>
    </div>
  );
};

export default Properties;
