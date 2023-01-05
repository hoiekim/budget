import { Dispatch, SetStateAction, useState } from "react";
import { Budget, Category, DeepPartial, Section } from "server";
import {
  currencyCodeToSymbol,
  numberToCommaString,
  useAppContext,
  CalculatedProperties,
} from "client";
import Bar from "./Bar";
import EditButton from "./EditButton";
import ActionButtons from "./ActionButtons";
import NameInput from "./NameInput";
import CapacityInput from "./CapacityInput";
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
  onClickInfo,
  editingState,
}: Props) => {
  const { selectedInterval } = useAppContext();
  const { name, capacities, sorted_amount = 0, unsorted_amount = 0 } = data;

  const [nameInput, setNameInput] = useState(name);
  const [capacityInput, setCapacityInput] = useState(capacities[selectedInterval]);

  const [_isEditingThis, _setIsEditingThis] = useState(false);
  const [_editingDataId, _setEditingDataId] = editingState || [];

  const isEditingThis = editingState ? _editingDataId === dataId : _isEditingThis;
  const isEditingAny = editingState && !!_editingDataId;

  const startEditingThis = () => {
    if (editingState && _setEditingDataId) _setEditingDataId(dataId);
    else _setIsEditingThis(true);
  };

  const finishEditingThis = () => {
    if (editingState && _setEditingDataId) _setEditingDataId(null);
    else _setIsEditingThis(false);
  };

  const _onClickInfo = () => {
    if (isEditingThis) return;
    if (isEditingAny && _setEditingDataId) {
      _setEditingDataId(null);
      return;
    }
    onClickInfo();
  };

  const capacity = capacities[selectedInterval];
  const total = sorted_amount + unsorted_amount;
  const leftover = capacity - total;

  const labeledRatio = sorted_amount / capacity;
  const unlabledRatio = unsorted_amount / capacity;

  const onComplete = async () => {
    try {
      await onSubmit({
        name: nameInput,
        capacities: { [selectedInterval]: capacityInput },
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
    <div className={classes.join(" ")} onClick={_onClickInfo}>
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
            <div>
              <span>{currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <CapacityInput
                key={`${dataId}_${selectedInterval}`}
                defaultValue={capacity}
                isEditing={isEditingThis}
                onChange={(e) => setCapacityInput(+e.target.value)}
              />
            </div>
          ) : (
            <>
              <div>
                <span>{currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
                <span className="currentTotal">
                  {numberToCommaString(Math.abs(total))}
                </span>
                <span>
                  &nbsp;
                  {total >= 0 ? "spent" : "earned"}
                </span>
              </div>
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
            </>
          )}
        </div>
      </div>
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
