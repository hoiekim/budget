import { Dispatch, SetStateAction, useState } from "react";
import { Budget, Category, DeepPartial, Section } from "server";
import {
  currencyCodeToSymbol,
  numberToCommaString,
  useAppContext,
  CalculatedProperties,
  MAX_FLOAT,
  getDateString,
  useCalculator,
  appendTimeString,
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
  const { viewDate } = useAppContext();
  const calculate = useCalculator();

  const {
    name,
    capacities,
    sorted_amount = 0,
    unsorted_amount = 0,
    rolled_over_amount,
    roll_over,
    roll_over_start_date,
  } = data;

  const interval = viewDate.getInterval();

  const capacity = capacities[interval];
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
        capacities: { [interval]: calculatedCapacity },
        roll_over: isRollOverInput,
        roll_over_start_date: appendTimeString(getDateString(rollOverStartDateInput)),
      });
      if (isRollOverInput) calculate();
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

  const CurrencySymbolSpan = () => (
    <span>{currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
  );

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
                  <CurrencySymbolSpan />
                  <CapacityInput
                    key={`${dataId}_${interval}`}
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
                <CurrencySymbolSpan />
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
                  <div>
                    <CurrencySymbolSpan />
                    <span className="currentTotal">
                      {numberToCommaString(Math.abs(leftover))}
                    </span>
                    <span>
                      &nbsp;
                      {leftover >= 0 ? "left" : "over"}
                    </span>
                  </div>
                  {roll_over && rolled_over_amount !== undefined && (
                    <div>
                      <span>{rolled_over_amount <= 0 ? "+" : "-"}</span>
                      <CurrencySymbolSpan />
                      <span className="currentTotal">
                        {numberToCommaString(Math.abs(rolled_over_amount))}
                      </span>
                      <span>&nbsp;rolled</span>
                    </div>
                  )}
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
