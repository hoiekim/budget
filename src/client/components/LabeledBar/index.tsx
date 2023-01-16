import { Dispatch, SetStateAction, useState } from "react";
import { Budget, Category, DeepPartial, Section } from "server";
import {
  useAppContext,
  CalculatedProperties,
  MAX_FLOAT,
  getDateString,
  useCalculator,
  appendTimeString,
} from "client";
import NameInput from "./NameInput";
import EditButton from "./EditButton";
import Bar from "./Bar";
import InfoText from "./InfoText";
import ToggleInput from "./ToggleInput";
import ActionButtons from "./ActionButtons";
import { useReorder } from "./lib";
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
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

const LabeledBar = ({
  dataId,
  data,
  iso_currency_code,
  onSubmit,
  onDelete: _onDelete,
  onClickInfo: _onClickInfo,
  editingState,
  onSetOrder,
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

  const {
    onDragStart,
    onDragEnd,
    onDragEnter,
    onGotPointerCapture,
    onTouchHandleStart,
    onTouchHandleEnd,
    onPointerEnter,
    isDragging,
    isClickAllowed,
  } = useReorder(dataId, onSetOrder);

  const [nameInput, setNameInput] = useState(name);
  const getCapacityInput = () => (isInfinite ? 0 : capacity * (isIncome ? -1 : 1));
  const [capacityInput, setCapacityInput] = useState(getCapacityInput());

  const [isInfiniteInput, setIsInfiniteInput] = useState(isInfinite);
  const [isIncomeInput, setIsIncomeInput] = useState(isIncome);
  const [isRollOverInput, setIsRollOverInput] = useState(roll_over);
  const getRollOverStartDateInput = () =>
    roll_over_start_date ? new Date(roll_over_start_date) : new Date();
  const [rollOverStartDateInput, setRollOverStartDateInput] = useState(
    getRollOverStartDateInput()
  );

  const [_isEditingThis, _setIsEditingThis] = useState(false);
  const [editingDataId, setEditingDataId] = editingState || [];

  const isEditingThis = editingState ? editingDataId === dataId : _isEditingThis;
  const isEditingAny = editingState && !!editingDataId;

  const startEditing = () => {
    if (isDragging || !isClickAllowed) return;
    setNameInput(name);
    setCapacityInput(getCapacityInput());
    setIsInfiniteInput(isInfinite);
    setIsIncomeInput(isIncome);
    setIsRollOverInput(roll_over);
    setRollOverStartDateInput(getRollOverStartDateInput());
    if (editingState && setEditingDataId) setEditingDataId(dataId);
    else _setIsEditingThis(true);
  };

  const finishEditing = () => {
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

  let barCapacity = isEditingThis ? capacityInput : capacity;
  if (isEditingThis && isIncomeInput) barCapacity *= -1;

  const total = sorted_amount + unsorted_amount;
  const leftover = barCapacity - total;

  const shouldIgnoreBarLength = isEditingThis ? isInfiniteInput : isInfinite;

  const labeledRatio = shouldIgnoreBarLength ? undefined : sorted_amount / barCapacity;
  const unlabledRatio = shouldIgnoreBarLength ? undefined : unsorted_amount / barCapacity;

  const onComplete = async () => {
    let calculatedCapacity = isInfiniteInput ? MAX_FLOAT : capacityInput;
    if (isIncomeInput) calculatedCapacity *= -1;
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
    finishEditing();
  };

  const onDelete = async () => {
    try {
      await _onDelete();
    } catch (error: any) {
      console.error(error);
    }
    finishEditing();
  };

  const classes = ["LabeledBar"];
  if (isDragging) classes.push("dragging");
  if (isEditingThis) classes.push("editing");

  const noAlert = isEditingThis ? isIncomeInput : isIncome;

  return (
    <div
      className={classes.join(" ")}
      onClick={() => onClickInfo()}
      draggable={true}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onPointerEnter={onPointerEnter}
      onDragEnd={onDragEnd}
    >
      <div className="title">
        <NameInput
          defaultValue={nameInput}
          isEditing={isEditingThis}
          onChange={(e) => setNameInput(e.target.value)}
        />
        {!isEditingThis && (
          <EditButton
            onEdit={startEditing}
            onTouchStart={onTouchHandleStart}
            onTouchEnd={onTouchHandleEnd}
            onGotPointerCapture={onGotPointerCapture}
          />
        )}
      </div>
      <div className="statusBarWithText">
        <Bar ratio={labeledRatio} unlabledRatio={unlabledRatio} noAlert={noAlert} />
        <InfoText
          dataId={dataId}
          isEditingThis={isEditingThis}
          isIncome={isIncome}
          isInfinite={isInfinite}
          isInfiniteInput={isInfiniteInput}
          capacityInput={capacityInput}
          setCapacityInput={setCapacityInput}
          iso_currency_code={iso_currency_code}
          total={total}
          leftover={leftover}
          roll_over={roll_over}
          rolled_over_amount={rolled_over_amount}
        />
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
          onCancel={finishEditing}
          onDelete={onDelete}
        />
      )}
    </div>
  );
};

export default LabeledBar;
