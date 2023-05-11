import { Dispatch, SetStateAction } from "react";
import { getDateString } from "common";
import ToggleInput from "./ToggleInput";
import RadioInputs from "./RadioInputs";
import "./index.css";

interface Props {
  isIncome: boolean;
  isIncomeInput: boolean;
  setIsIncomeInput: Dispatch<SetStateAction<boolean>>;
  isInfinite: boolean;
  isInfiniteInput: boolean;
  setIsInfiniteInput: Dispatch<SetStateAction<boolean>>;
  isRollOver: boolean;
  isRollOverInput: boolean;
  setIsRollOverInput: Dispatch<SetStateAction<boolean>>;
  rollOverStartDate: Date;
  rollOverStartDateInput: Date;
  setRollOverStartDateInput: Dispatch<SetStateAction<Date>>;
}

const Properties = ({
  isIncome,
  isIncomeInput,
  setIsIncomeInput,
  isInfinite,
  isInfiniteInput,
  setIsInfiniteInput,
  isRollOver,
  isRollOverInput,
  setIsRollOverInput,
  rollOverStartDate,
  rollOverStartDateInput,
  setRollOverStartDateInput,
}: Props) => {
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
            defaultChecked={!isInfinite}
            onChange={(e) => setIsInfiniteInput(!e.target.checked)}
          />
        </div>
        {!isInfiniteInput && (
          <>
            <div className="row">
              <span>Rolls over to the next period</span>
              <ToggleInput
                defaultChecked={isRollOver}
                onChange={(e) => setIsRollOverInput(e.target.checked)}
              />
            </div>
            {isRollOverInput && (
              <div className="row">
                <span>Start date:&nbsp;</span>
                <input
                  type="date"
                  value={getDateString(rollOverStartDateInput)}
                  onChange={(e) => setRollOverStartDateInput(new Date(e.target.value))}
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
