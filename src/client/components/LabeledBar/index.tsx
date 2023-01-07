import { Dispatch, SetStateAction, useState } from "react";
import { Budget, Category, DeepPartial, Section } from "server";
import {
  currencyCodeToSymbol,
  numberToCommaString,
  useAppContext,
  CalculatedProperties,
  MAX_FLOAT,
  getDateString,
} from "client";
import Bar from "./Bar";
import EditButton from "./EditButton";
import ActionButtons from "./ActionButtons";
import NameInput from "./NameInput";
import CapacityInput from "./CapacityInput";
import ToggleInput from "./ToggleInput";
import "./index.css";

export type BarData = (Budget | Section | Category) & CalculatedProperties;

interface Props {
  dataId: string;
  data: BarData;
  iso_currency_code: string;
  onSubmit: (updatedData: DeepPartial<BarData>) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onClickInfo: () => void;
  editingState?: [string | null, Dispatch<SetStateAction<string | null>>];
}

const LabeledBar = ({
  dataId,
  data,
  iso_currency_code,
  onSubmit,
  onDelete,
  onClickInfo: _onClickInfo,
  editingState,
}: Props) => {
  const { selectedInterval } = useAppContext();
  const {
    name,
    capacities,
    sorted_amount = 0,
    unsorted_amount = 0,
    roll_over,
    roll_over_start_date,
  } = data;

  const capacity = capacities[selectedInterval];
  const isInfinite = capacity === MAX_FLOAT || capacity === -MAX_FLOAT;
  const isIncome = capacity < 0;

  const [nameInput, setNameInput] = useState(name);
  const [capacityInput, setCapacityInput] = useState(isInfinite ? 0 : capacity);

  const [isInfiniteInput, setIsInfiniteInput] = useState(isInfinite);
  const [isIncomeInput, setIsIncomeInput] = useState(isIncome);
  const [isRollOverInput, setIsRollOverInput] = useState(roll_over);
  const [rollOverStartDateInput, setRollOverStartDateInput] = useState(
    roll_over_start_date ? new Date(roll_over_start_date) : new Date()
  );

  const [_isEditingThis, _setIsEditingThis] = useState(false);
  const [editingDataId, setEditingDataId] = editingState || [];

  const isEditingThis = editingState ? editingDataId === dataId : _isEditingThis;
  const isEditingAny = editingState && !!editingDataId;

  const startEditingThis = () => {
    setNameInput(name);
    setCapacityInput(isInfinite ? 0 : capacity);
    setIsInfiniteInput(isInfinite);
    setIsIncomeInput(isIncome);
    setIsRollOverInput(roll_over);
    setRollOverStartDateInput(
      roll_over_start_date ? new Date(roll_over_start_date) : new Date()
    );
    if (editingState && setEditingDataId) setEditingDataId(dataId);
    else _setIsEditingThis(true);
  };

  const finishEditingThis = () => {
    if (editingState && setEditingDataId) setEditingDataId(null);
    else _setIsEditingThis(false);
  };

  const onClickInfo = () => {
    if (isEditingThis) return;
    if (isEditingAny && setEditingDataId) {
      setEditingDataId(null);
      return;
    }
    _onClickInfo();
  };

  const total = sorted_amount + unsorted_amount;
  const leftover = capacity - total;

  const shouldIgnoreBarLength = isEditingThis ? isInfiniteInput : isInfinite;

  const labeledRatio = shouldIgnoreBarLength ? undefined : sorted_amount / capacity;
  const unlabledRatio = shouldIgnoreBarLength ? undefined : unsorted_amount / capacity;

  const onComplete = async () => {
    let calculatedCapacity = isInfiniteInput ? MAX_FLOAT : capacityInput;
    if (isIncome) calculatedCapacity *= -1;
    try {
      await onSubmit({
        name: nameInput,
        capacities: { [selectedInterval]: calculatedCapacity },
        roll_over: isRollOverInput,
        roll_over_start_date: getDateString(new Date()),
      });
    } catch (error: any) {
      console.error(error);
    }
    finishEditingThis();
  };

  const _onDelete = async () => {
    try {
      await onDelete();
    } catch (error: any) {
      console.error(error);
    }
    finishEditingThis();
  };

  const classes = ["LabeledBar"];
  if (isEditingThis) classes.push("editing");

  return (
    <div className={classes.join(" ")} onClick={onClickInfo}>
      <div className="title">
        <NameInput
          defaultValue={nameInput}
          isEditing={isEditingThis}
          onChange={(e) => setNameInput(e.target.value)}
        />
        {!isEditingThis && <EditButton onEdit={startEditingThis} />}
      </div>
      <div className="statusBarWithText">
        <Bar ratio={labeledRatio} unlabledRatio={unlabledRatio} />
        <div className="infoText">
          {isEditingThis ? (
            <div className="fullLength">
              {isInfiniteInput ? (
                <span>Unlimited</span>
              ) : (
                <>
                  <span>{currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
                  <CapacityInput
                    key={`${dataId}_${selectedInterval}`}
                    defaultValue={capacityInput}
                    isEditing={isEditingThis}
                    onChange={(e) => setCapacityInput(Math.abs(+e.target.value))}
                  />
                </>
              )}
            </div>
          ) : (
            <>
              <div className={isInfinite ? "fullLength" : undefined}>
                <span>{currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
                <span className="currentTotal">
                  {numberToCommaString(Math.abs(total))}
                </span>
                <span>
                  &nbsp;
                  {total >= 0 ? "spent" : "earned"}
                </span>
              </div>
              {!isInfinite && (
                <div>
                  <span>{currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
                  <span className="currentTotal">
                    {numberToCommaString(Math.abs(leftover))}
                  </span>
                  <span>
                    &nbsp;
                    {leftover >= 0 ? "left" : "over"}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {isEditingThis && (
        <div className="properties">
          <ToggleInput
            defaultChecked={isInfiniteInput}
            onChange={(e) => setIsInfiniteInput(e.target.checked)}
          >
            {isInfiniteInput ? "Unlimited" : "Limited"}
          </ToggleInput>
          <ToggleInput
            defaultChecked={isIncomeInput}
            onChange={(e) => setIsIncomeInput(e.target.checked)}
          >
            {isIncomeInput ? "Income" : "Expense"}
          </ToggleInput>
          <ToggleInput
            defaultChecked={isRollOverInput}
            onChange={(e) => setIsRollOverInput(e.target.checked)}
          >
            {isRollOverInput ? "Rolls Over" : "Resets"}
          </ToggleInput>
          {isRollOverInput && (
            <div className="rollOverStartDate">
              <span>Roll Over Start Date:&nbsp;</span>
              <input
                type="date"
                value={getDateString(rollOverStartDateInput)}
                onChange={(e) => setRollOverStartDateInput(new Date(e.target.value))}
              />
            </div>
          )}
        </div>
      )}
      {isEditingThis && (
        <ActionButtons
          onComplete={onComplete}
          onCancel={finishEditingThis}
          onDelete={_onDelete}
        />
      )}
    </div>
  );
};

export default LabeledBar;
