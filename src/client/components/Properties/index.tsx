import { ChangeEventHandler, Dispatch, SetStateAction } from "react";
import { ViewDate, getDateString, getDateTimeString } from "common";
import { useAppContext } from "client";
import ToggleInput from "./ToggleInput";
import RadioInputs from "./RadioInputs";
import "./index.css";

interface Props {
  isIncomeInput: boolean;
  setIsIncomeInput: Dispatch<SetStateAction<boolean>>;
  isInfiniteInput: boolean;
  setIsInfiniteInput: Dispatch<SetStateAction<boolean>>;
  isRollOverInput: boolean;
  setIsRollOverInput: Dispatch<SetStateAction<boolean>>;
  rollOverStartDateInput: Date;
  setRollOverStartDateInput: Dispatch<SetStateAction<Date>>;
}

const Properties = ({
  isIncomeInput,
  setIsIncomeInput,
  isInfiniteInput,
  setIsInfiniteInput,
  isRollOverInput,
  setIsRollOverInput,
  rollOverStartDateInput,
  setRollOverStartDateInput,
}: Props) => {
  const { viewDate } = useAppContext();

  const onChangeRollDate: ChangeEventHandler<HTMLInputElement> = (e) => {
    const inputDate = new Date(getDateTimeString(e.target.value));
    const dateHelper = new ViewDate(viewDate.getInterval(), inputDate);
    const newRollDate = dateHelper.getDateAsStartDate();
    setRollOverStartDateInput(newRollDate);
  };

  return (
    <div className="Properties">
      <div className="property">
        <RadioInputs
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
            checked={!isInfiniteInput}
            onChange={(e) => setIsInfiniteInput(!e.target.checked)}
          />
        </div>
        {!isInfiniteInput && (
          <>
            <div className="row">
              <span>Rolls over to the next period</span>
              <ToggleInput
                checked={isRollOverInput}
                onChange={(e) => setIsRollOverInput(e.target.checked)}
              />
            </div>
            {isRollOverInput && (
              <div className="row">
                <span>Start date:&nbsp;</span>
                <input
                  type="date"
                  value={getDateString(rollOverStartDateInput)}
                  onChange={onChangeRollDate}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default Properties;
