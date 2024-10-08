import { Donut, TRANSPARENT, adjustBrightness, colors, useAppContext } from "client";
import {
  Budget,
  Capacity,
  Category,
  MAX_FLOAT,
  currencyCodeToSymbol,
  numberToCommaString,
} from "common";
import { DonutData } from "client/components";
import { BudgetFamily } from "common/models/BudgetFamily";
import CapacityInput from "./CapacityInput";
import { ChangeEventHandler } from "react";

interface Props {
  budgetLike: BudgetFamily;
  date: Date;
  isInfiniteInput: boolean;
  isSyncedInput: boolean;
  capacityInput: Capacity;
  defaultCapacityInput: Capacity;
  onChangeAmount: ChangeEventHandler<HTMLInputElement>;
}

const ID_DIFF = "diff";
const LABEL_UNNAMED = "Unnamed";

const BudgetDonut = ({
  budgetLike,
  date,
  isInfiniteInput,
  isSyncedInput,
  capacityInput,
  defaultCapacityInput,
  onChangeAmount,
}: Props) => {
  const { viewDate } = useAppContext();
  const interval = viewDate.getInterval();
  const children = budgetLike.getChildren().sort((a, b) => {
    return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
  });

  const childrenDonutData: DonutData[] = [];
  const childToGrandChildrenMap = new Map<string, DonutData[]>();

  let isChildrenInfinite = false;
  let childrenTotal = 0;

  children.forEach((child, i) => {
    const grandChildrenDonutData: DonutData[] = [];
    childToGrandChildrenMap.set(child.id, grandChildrenDonutData);

    const childValue = child.getActiveCapacity(date)[interval];
    if (Math.abs(childValue) === MAX_FLOAT) console.log(child);
    isChildrenInfinite = isChildrenInfinite || Math.abs(childValue) === MAX_FLOAT;
    childrenTotal += childValue;

    const childColor = colors[i % colors.length];

    childrenDonutData.push({
      id: child.id,
      value: childValue,
      color: childColor,
      label: child.name || LABEL_UNNAMED,
    });

    let grandChildrenTotal = 0;
    const grandChildren = child.getChildren() as Category[];

    grandChildren.forEach((grandChild, j) => {
      const brightness = ((j % 2) + 1) * 0.3 + 1;
      const grandChildColor = adjustBrightness(childColor, brightness);
      const grandChildValue = grandChild.getActiveCapacity(date)[interval];
      if (Math.abs(grandChildValue) === MAX_FLOAT) console.log(grandChild);
      isChildrenInfinite = isChildrenInfinite || Math.abs(grandChildValue) === MAX_FLOAT;
      grandChildrenTotal += grandChildValue;
      grandChildrenDonutData.push({
        id: grandChild.id,
        value: grandChildValue,
        color: grandChildColor,
        label: grandChild.name || LABEL_UNNAMED,
      });
    });

    const childDiff = childValue - grandChildrenTotal;
    const fillerData = { id: ID_DIFF, value: Math.abs(childDiff), color: TRANSPARENT };
    if (childValue > grandChildrenTotal) grandChildrenDonutData.push(fillerData);
    else if (childValue < grandChildrenTotal) childrenDonutData.push(fillerData);
  });

  const flatGrandChildrenDonutData = Array.from(childToGrandChildrenMap.values()).flat();

  const capacityAmount = capacityInput[interval];

  const parentDonutData: DonutData[] = [
    { id: budgetLike.id, value: capacityAmount, color: "#666" },
  ];

  const parentDiff = capacityAmount - childrenTotal;
  const fillerData = { id: ID_DIFF, value: Math.abs(parentDiff), color: TRANSPARENT };
  if (childrenTotal > capacityAmount) {
    parentDonutData.push(fillerData);
  } else if (childrenTotal < capacityAmount) {
    childrenDonutData.push(fillerData);
    flatGrandChildrenDonutData.push(fillerData);
  }

  const isParentInfinite = Math.abs(capacityAmount) === MAX_FLOAT;
  if (isChildrenInfinite || isParentInfinite) {
    return <div className="BudgetDonut">Unlimited</div>;
  }

  const currencyCode = (budgetLike as Budget)["iso_currency_code"] || "USD";
  const currencySymbol = currencyCodeToSymbol(currencyCode);

  const capacityBreakDown = childrenDonutData
    .filter((c, i) => !(c.id === ID_DIFF && i === childrenDonutData.length - 1))
    .flatMap((c, i) => {
      const grandChildrenDonutData = childToGrandChildrenMap.get(c.id) || [];
      const adjustments = grandChildrenDonutData.filter((gc) => gc.id === ID_DIFF);
      return [
        <tr
          key={`capacityBreakDown_row_${i}`}
          className={c.id === ID_DIFF ? "colored alert" : undefined}
        >
          <td>
            <div
              className="colored"
              style={{ width: "5px", height: "12px", backgroundColor: c.color }}
            />
          </td>
          <td>{c.label}</td>
          <td>
            {c.id === ID_DIFF && <>+&nbsp;</>}
            {currencySymbol}&nbsp;{numberToCommaString(c.value, 0)}
          </td>
        </tr>,
        ...(adjustments || []).map((a, j) => (
          <tr key={`capacityBreakDown_row_${i}_${j}`}>
            <td>
              <div
                className="colored"
                style={{ width: "5px", height: "12px", backgroundColor: a.color }}
              />
            </td>
            <td />
            <td className="colored alert">
              -&nbsp;{currencySymbol}&nbsp;{numberToCommaString(a.value, 0)}
            </td>
          </tr>
        )),
      ];
    });

  const defaultCapacityValue = defaultCapacityInput[interval];
  const capacityValue = capacityInput[interval];
  const capacityInputWidth = `${numberToCommaString(Math.abs(capacityValue), 0).length + 1}ch`;

  return (
    <div className="BudgetDonut">
      <div className="details">
        <div className="labeledDonuts">
          <div className="donuts">
            {parentDonutData.length > 1 && (
              <Donut data={parentDonutData} radius={73} thickness={7} />
            )}
            <Donut data={childrenDonutData} radius={60} thickness={10} />
            <Donut data={flatGrandChildrenDonutData} radius={50} thickness={10} />
          </div>
          <div className="centerLabel">
            <div>
              {!isInfiniteInput && (
                <div>
                  <span>{currencyCodeToSymbol(currencyCode)}</span>
                  <CapacityInput
                    style={{ width: capacityInputWidth }}
                    disabled={isSyncedInput}
                    defaultValue={defaultCapacityValue}
                    onBlur={onChangeAmount}
                  />
                </div>
              )}
              {!!parentDiff && (
                <div className="colored alert">
                  <span>
                    {parentDiff < 0 ? "+" : "-"}&nbsp;{currencySymbol}&nbsp;
                  </span>
                  <span style={{ width: capacityInputWidth, textAlign: "center" }}>
                    {numberToCommaString(Math.abs(parentDiff), 0)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="capacityBreakDown">
          <table>
            <tbody>{capacityBreakDown}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default BudgetDonut;
