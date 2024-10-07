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
  const grandChildrenDonutData: DonutData[] = [];

  let isChildrenInfinite = false;
  let childrenTotal = 0;

  children.forEach((child, i) => {
    const childValue = child.getActiveCapacity(date)[interval];
    if (Math.abs(childValue) === MAX_FLOAT) console.log(child);
    isChildrenInfinite = isChildrenInfinite || Math.abs(childValue) === MAX_FLOAT;
    childrenTotal += childValue;

    childrenDonutData.push({
      id: child.id,
      value: childValue,
      color: colors[i % colors.length],
      label: child.name || LABEL_UNNAMED,
    });

    let grandChildrenTotal = 0;
    const grandChildren = child.getChildren() as Category[];

    grandChildren.forEach((grandChild, j) => {
      const brightness = ((j % 2) + 1) * 0.3 + 1;
      const color = adjustBrightness(colors[i % colors.length], brightness);
      const grandChildValue = grandChild.getActiveCapacity(date)[interval];
      if (Math.abs(grandChildValue) === MAX_FLOAT) console.log(grandChild);
      isChildrenInfinite = isChildrenInfinite || Math.abs(grandChildValue) === MAX_FLOAT;
      grandChildrenTotal += grandChildValue;
      grandChildrenDonutData.push({
        id: grandChild.id,
        value: grandChildValue,
        color: color,
        label: grandChild.name || LABEL_UNNAMED,
      });
    });

    const childDiff = childValue - grandChildrenTotal;
    if (childValue > grandChildrenTotal) {
      grandChildrenDonutData.push({ id: ID_DIFF, value: childDiff, color: TRANSPARENT });
    } else if (childValue < grandChildrenTotal) {
      childrenDonutData.push({ id: ID_DIFF, value: -childDiff, color: TRANSPARENT });
    }
  });

  const capacityAmount = capacityInput[interval];

  const parentDonutData: DonutData[] = [
    { id: budgetLike.id, value: capacityAmount, color: "#666" },
  ];

  const parentDiff = capacityAmount - childrenTotal;
  if (childrenTotal > capacityAmount) {
    parentDonutData.push({ id: ID_DIFF, value: -parentDiff, color: TRANSPARENT });
  } else if (childrenTotal < capacityAmount) {
    childrenDonutData.push({ id: ID_DIFF, value: parentDiff, color: TRANSPARENT });
    grandChildrenDonutData.push({ id: ID_DIFF, value: parentDiff, color: TRANSPARENT });
  }

  const isParentInfinite = Math.abs(capacityAmount) === MAX_FLOAT;
  if (isChildrenInfinite || isParentInfinite) {
    return <div className="BudgetDonut">Unlimited</div>;
  }

  const currencyCode = (budgetLike as Budget)["iso_currency_code"] || "USD";
  const currencySymbol = currencyCodeToSymbol(currencyCode);

  const capacityBreakDown = childrenDonutData.map((d, i) => {
    return (
      <tr key={i} className={d.label ? undefined : "colored alert"}>
        <td>{d.label || "Not Specified"}</td>
        <td>
          {currencySymbol}&nbsp;{numberToCommaString(d.value, 0)}
        </td>
      </tr>
    );
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
            <Donut data={grandChildrenDonutData} radius={50} thickness={10} />
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
              {parentDiff < 0 && (
                <div className="colored alert">
                  <span>{currencySymbol}&nbsp;</span>
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
