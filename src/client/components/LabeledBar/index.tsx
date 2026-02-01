import { Dispatch, SetStateAction } from "react";
import { MAX_FLOAT, currencyCodeToSymbol, numberToCommaString } from "common";
import { Budget, Category, Section, useReorder, useAppContext } from "client";
import { Bar } from "client/components";
import EditButton from "./EditButton";
import "./index.css";

export type BarData = Budget | Section | Category;

export type BudgetType = "income" | "expense";

interface Props {
  dataId: string;
  barData: BarData;
  iso_currency_code: string;
  onClickInfo: () => void;
  onClickEdit?: () => void;
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
  hideEditButton?: boolean;
}

export const LabeledBar = ({
  dataId,
  barData,
  iso_currency_code,
  onClickInfo,
  onClickEdit,
  onSetOrder,
  hideEditButton,
}: Props) => {
  const { viewDate } = useAppContext();

  const {
    name,
    sorted_amount = 0,
    unsorted_amount = 0,
    rolled_over_amount,
    roll_over,
    roll_over_start_date,
  } = barData;

  const capacity = barData.getActiveCapacity(viewDate.getEndDate());
  const interval = viewDate.getInterval();
  const capacityValue = capacity[interval];
  const isInfinite = capacityValue === MAX_FLOAT || capacityValue === -MAX_FLOAT;
  const isIncome = capacityValue < 0;

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

  const startEditing = () => {
    if (isDragging || !isClickAllowed) return;
    if (onClickEdit) onClickEdit();
  };

  const total = sorted_amount + unsorted_amount;
  const leftover = capacityValue - total;

  const labeledRatio = isInfinite ? undefined : sorted_amount / capacityValue;
  const unlabledRatio = isInfinite ? undefined : unsorted_amount / capacityValue;

  const classes = ["LabeledBar"];
  if (isDragging) classes.push("dragging");

  const CurrencySymbolSpan = <span>{currencyCodeToSymbol(iso_currency_code)}</span>;

  const shouldShowRolledAmount =
    roll_over &&
    rolled_over_amount !== undefined &&
    roll_over_start_date &&
    roll_over_start_date < viewDate.getEndDate();

  const editButtonClassName =
    barData.isChildrenSynced(interval) || hideEditButton ? undefined : "notification";

  return (
    <div
      className={classes.join(" ")}
      onClick={onClickInfo}
      draggable={true}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onPointerEnter={onPointerEnter}
      onDragEnd={onDragEnd}
    >
      <div className="title">
        <span>{name}</span>
        <EditButton
          className={editButtonClassName}
          isCompact={!!hideEditButton}
          onEdit={startEditing}
          onTouchStart={onTouchHandleStart}
          onTouchEnd={onTouchHandleEnd}
          onGotPointerCapture={onGotPointerCapture}
          style={{ touchAction: "none" }}
        />
      </div>
      <div className="statusBarWithText">
        <Bar
          memoryKey={dataId}
          ratio={labeledRatio}
          unlabeledRatio={unlabledRatio}
          noAlert={isIncome}
        />
        <div className="infoText">
          <div className={isInfinite ? "fullLength" : undefined}>
            <table>
              <tbody>
                <tr>
                  <td>{CurrencySymbolSpan}</td>
                  <td>
                    <span className="currentTotal">{numberToCommaString(Math.abs(total), 0)}</span>
                  </td>
                  <td>
                    <span>{total >= 0 ? "spent" : "gained"}</span>
                  </td>
                </tr>
                {!isInfinite && (
                  <tr>
                    <td colSpan={3}>
                      <span>of&nbsp;</span>
                      {CurrencySymbolSpan}&nbsp;
                      <span className="capacity">
                        {numberToCommaString(Math.abs(capacityValue), 0)}
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!isInfinite && (
            <div>
              <table>
                <tbody>
                  <tr>
                    <td>{CurrencySymbolSpan}</td>
                    <td>
                      <span className="currentTotal">
                        {numberToCommaString(Math.abs(leftover), 0)}
                      </span>
                    </td>
                    <td style={{ textAlign: "left" }}>
                      <span>{0 <= (isIncome ? -leftover : leftover) ? "left" : "over"}</span>
                    </td>
                  </tr>
                  {shouldShowRolledAmount && (
                    <tr>
                      <td>
                        <span>{rolled_over_amount <= 0 ? "+" : "-"}</span>
                        {CurrencySymbolSpan}
                      </td>
                      <td>
                        <span className="currentTotal">
                          {numberToCommaString(Math.abs(rolled_over_amount), 0)}
                        </span>
                      </td>
                      <td>
                        <span>rolled</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
