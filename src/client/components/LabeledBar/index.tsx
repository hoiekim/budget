import { Dispatch, SetStateAction } from "react";
import { useAppContext, PATH } from "client";
import { Bar } from "client/components";
import {
  MAX_FLOAT,
  Budget,
  Category,
  Section,
  currencyCodeToSymbol,
  numberToCommaString,
} from "common";
import EditButton from "./EditButton";
import { useReorder } from "./lib";
import "./index.css";

export type BarData = Budget | Section | Category;

export type BudgetType = "income" | "expense";

interface Props {
  dataId: string;
  data: BarData;
  iso_currency_code: string;
  onClickInfo: () => void;
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

const LabeledBar = ({
  dataId,
  data,
  iso_currency_code,
  onClickInfo: _onClickInfo,
  onSetOrder,
}: Props) => {
  const { viewDate, router } = useAppContext();

  const {
    name,
    sorted_amount = 0,
    unsorted_amount = 0,
    rolled_over_amount,
    roll_over,
    roll_over_start_date,
  } = data;

  const capacity = data.getActiveCapacity(viewDate.getDate());
  const capacityValue = capacity[viewDate.getInterval()];
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
    router.go(PATH.BUDGET_CONFIG, { params: new URLSearchParams({ id: dataId }) });
  };

  const onClickInfo = () => {
    _onClickInfo();
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
    roll_over_start_date < viewDate.getDate();

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
        <span>{name}</span>
        <EditButton
          onEdit={startEditing}
          onTouchStart={onTouchHandleStart}
          onTouchEnd={onTouchHandleEnd}
          onGotPointerCapture={onGotPointerCapture}
        />
      </div>
      <div className="statusBarWithText">
        <Bar ratio={labeledRatio} unlabledRatio={unlabledRatio} noAlert={isIncome} />
        <div className="infoText">
          <div className={isInfinite ? "fullLength" : undefined}>
            <table>
              <tbody>
                <tr>
                  <td>{CurrencySymbolSpan}</td>
                  <td>
                    <span className="currentTotal">
                      {numberToCommaString(Math.abs(total))}
                    </span>
                  </td>
                  <td>
                    <span>{total >= 0 ? "spent" : "gained"}</span>
                  </td>
                </tr>
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
                        {numberToCommaString(Math.abs(leftover))}
                      </span>
                    </td>
                    <td style={{ textAlign: "left" }}>
                      <span>
                        {(isIncome ? leftover < 0 : 0 <= leftover) ? "left" : "over"}
                      </span>
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
                          {numberToCommaString(Math.abs(rolled_over_amount))}
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

export default LabeledBar;
