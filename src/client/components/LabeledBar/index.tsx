import { Dispatch, SetStateAction, useRef, useState } from "react";
import { Budget, Category, DeepPartial, Section } from "server";
import {
  currencyCodeToSymbol,
  numberToCommaString,
  useAppContext,
  CalculatedProperties,
} from "client";
import Bar from "client/components/LabeledBar/Bar";
import CapacityInput from "client/components/LabeledBar/CapacityInput";
import EditButton from "client/components/LabeledBar/EditButton";
import NameInput from "client/components/LabeledBar/NameInput";
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

  const [_isEditingThis, _setIsEditingThis] = useState(false);
  const [_editingDataId, _setEditingDataId] = editingState || [];

  const isEditingThis = _editingDataId ? _editingDataId === dataId : _isEditingThis;
  const isEditingAny = editingState && !!_editingDataId;

  const startEditingThis = () => {
    if (_setEditingDataId) _setEditingDataId(dataId);
    else _setIsEditingThis(true);
  };

  const finishEditingThis = () => {
    if (_setEditingDataId) _setEditingDataId(null);
    else _setIsEditingThis(false);
  };

  const _onClickInfo = () => {
    if (isEditingThis || isEditingAny) return;
    onClickInfo();
  };

  const capacity = capacities[selectedInterval];
  const total = sorted_amount + unsorted_amount;
  const leftover = capacity - total;

  const labeledRatio = sorted_amount / capacity;
  const unlabledRatio = unsorted_amount / capacity;

  const timeout = useRef<ReturnType<typeof setTimeout>>();

  const submit = (updatedData: DeepPartial<BarData> = {}, onError?: () => void) => {
    clearTimeout(timeout.current);
    timeout.current = setTimeout(async () => {
      try {
        await onSubmit(updatedData);
      } catch (error: any) {
        console.error(error);
        if (onError) onError();
      }
    }, 500);
  };

  return (
    <div
      className="LabeledBar"
      onMouseLeave={() => finishEditingThis()}
      onClick={() => {
        finishEditingThis();
        _onClickInfo();
      }}
    >
      <div className="title">
        <NameInput
          defaultValue={name}
          isEditing={isEditingThis}
          submit={(value, onError) => {
            submit({ name: value }, onError);
          }}
        />
        <div className="buttons">
          <EditButton
            isEditing={isEditingThis}
            onEdit={() => startEditingThis()}
            onDelete={onDelete}
          />
        </div>
      </div>
      <div className="statusBarWithText">
        <Bar ratio={labeledRatio} unlabledRatio={unlabledRatio} />
        <div className="infoText">
          {!isEditingThis && (
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
          {isEditingThis && (
            <div>
              <span>{currencyCodeToSymbol(iso_currency_code)}&nbsp;</span>
              <CapacityInput
                key={`${dataId}_${selectedInterval}`}
                defaultValue={numberToCommaString(capacity)}
                isEditing={isEditingThis}
                submit={(value, onError) => {
                  submit({ capacities: { [selectedInterval]: +value } }, onError);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LabeledBar;

export { default as Bar } from "./Bar";
export { default as EditButton } from "./EditButton";
export { default as CapacityInput } from "./CapacityInput";
export { default as NameInput } from "./NameInput";
