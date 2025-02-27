import { ChangeEventHandler, Dispatch, SetStateAction } from "react";
import { Capacity, ViewDate, getDateString, getDateTimeString } from "common";
import { useAppContext } from "client";
import ToggleInput from "./ToggleInput";
import RadioInputs from "./RadioInputs";
import "./index.css";
import CapacitiesInput from "./CapacitiesInput";
import { BudgetFamily } from "common/models/BudgetFamily";

interface Props {
  budgetLike: BudgetFamily;
  isIncomeInput: boolean;
  setIsIncomeInput: Dispatch<SetStateAction<boolean>>;
  isInfiniteInput: boolean;
  setIsInfiniteInput: Dispatch<SetStateAction<boolean>>;
  isRollOverInput: boolean;
  setIsRollOverInput: Dispatch<SetStateAction<boolean>>;
  rollOverStartDateInput: Date;
  setRollOverStartDateInput: Dispatch<SetStateAction<Date>>;
  capacitiesInput: Capacity[];
  setCapacitiesInput: Dispatch<SetStateAction<Capacity[]>>;
  isSyncedInput: boolean;
  setIsSyncedInput: Dispatch<SetStateAction<boolean>>;
}

export const BudgetProperties = ({
  budgetLike,
  isIncomeInput,
  setIsIncomeInput,
  isInfiniteInput,
  setIsInfiniteInput,
  isRollOverInput,
  setIsRollOverInput,
  rollOverStartDateInput,
  setRollOverStartDateInput,
  capacitiesInput,
  setCapacitiesInput,
  isSyncedInput,
  setIsSyncedInput,
}: Props) => {
  const { viewDate } = useAppContext();

  const onChangeRollDate: ChangeEventHandler<HTMLInputElement> = (e) => {
    const inputDate = new Date(getDateTimeString(e.target.value));
    const dateHelper = new ViewDate(viewDate.getInterval(), inputDate);
    const newRollDate = dateHelper.getStartDate();
    setRollOverStartDateInput(newRollDate);
  };

  const onChangeSync: ChangeEventHandler<HTMLInputElement> = (e) => {
    setIsSyncedInput(e.target.checked);
  };

  const isCategory = budgetLike.type === "category";

  return (
    <div className="BudgetProperties Properties">
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
      {!isInfiniteInput && (
        <div className="property">
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
        </div>
      )}
      <div className="property">
        <div className="row">
          <span className={isCategory ? "disabled lineThrough" : undefined}>
            Sync with children
          </span>
          <ToggleInput
            disabled={isCategory}
            checked={isCategory ? false : isSyncedInput}
            onChange={onChangeSync}
          />
        </div>
        {!isInfiniteInput && (
          <CapacitiesInput
            budgetLike={budgetLike}
            capacitiesInput={capacitiesInput}
            setCapacitiesInput={setCapacitiesInput}
            isSyncedInput={isSyncedInput}
          />
        )}
      </div>
    </div>
  );
};
