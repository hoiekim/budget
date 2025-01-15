import { Donut, TRANSPARENT, adjustBrightness, colors, useAppContext } from "client";
import {
  Budget,
  Capacity,
  Category,
  MAX_FLOAT,
  currencyCodeToSymbol,
  numberToCommaString,
} from "common";
import { DonutData, CapacityInput } from "client/components";
import { BudgetFamily } from "common/models/BudgetFamily";
import { ChangeEventHandler } from "react";
import CapacityBreakDown from "./CapacityBreakDown";

interface Props {
  budgetLike: BudgetFamily;
  date: Date;
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
  isSyncedInput,
  capacityInput,
  defaultCapacityInput,
  onChangeAmount,
}: Props) => {
  const { viewDate } = useAppContext();
  const interval = viewDate.getInterval();
  const capacity = budgetLike.getActiveCapacity(date);
  const { children_total, grand_children_total } = capacity;
  const children = budgetLike.getChildren().sort((a, b) => {
    return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
  });

  const childrenDonutData: DonutData[] = [];
  const childToGrandChildrenMap = new Map<string, DonutData[]>();

  const isChildrenInfinite =
    Math.max(Math.abs(children_total), Math.abs(grand_children_total)) === MAX_FLOAT;

  children.forEach((child, i) => {
    const childCapacity = child.getActiveCapacity(date);
    const childValue = childCapacity[interval];
    const childColor = colors[i % colors.length];
    const childLabel = child.name || LABEL_UNNAMED;
    childrenDonutData.push({
      id: child.id,
      value: childValue,
      color: childColor,
      label: childLabel,
    });

    if (budgetLike.type === "budget") {
      const grandChildrenDonutData: DonutData[] = [];
      childToGrandChildrenMap.set(child.id, grandChildrenDonutData);
      const grandChildren = child.getChildren() as Category[];
      grandChildren.forEach((grandChild, j) => {
        const grandChildValue = grandChild.getActiveCapacity(date)[interval];
        const brightness = ((j % 2) + 1) * 0.3 + 1;
        const grandChildColor = adjustBrightness(childColor, brightness);
        const grandChildLabel = child.name || LABEL_UNNAMED;
        grandChildrenDonutData.push({
          id: grandChild.id,
          value: grandChildValue,
          color: grandChildColor,
          label: grandChildLabel,
        });
      });
      const childDiff = childValue - childCapacity.children_total;
      if (isSyncedInput) {
        childrenDonutData[childrenDonutData.length - 1].value -= childDiff;
      } else if (childDiff > 0) {
        const fillerData = { id: ID_DIFF, value: Math.abs(childDiff), color: TRANSPARENT };
        grandChildrenDonutData.push(fillerData);
      } else if (childDiff < 0) {
        const fillerData = { id: ID_DIFF, value: Math.abs(childDiff), color: TRANSPARENT };
        childrenDonutData.push(fillerData);
      }
    }
  });

  const flatGrandChildrenDonutData = Array.from(childToGrandChildrenMap.values()).flat();

  const capacityAmount = capacityInput[interval];

  const parentDonutData: DonutData[] = [
    { id: budgetLike.id, value: capacityAmount, color: "#666" },
  ];

  const syncingAmount = budgetLike.type === "budget" ? grand_children_total : children_total;
  const parentDiff = capacityAmount - syncingAmount;
  if (!isSyncedInput) {
    const fillerData = { id: ID_DIFF, value: Math.abs(parentDiff), color: TRANSPARENT };
    if (children_total > capacityAmount) {
      parentDonutData.push(fillerData);
    } else if (children_total < capacityAmount) {
      childrenDonutData.push(fillerData);
      flatGrandChildrenDonutData.push(fillerData);
    }
  }

  const currencyCode = (budgetLike as Budget)["iso_currency_code"] || "USD";
  const currencySymbol = currencyCodeToSymbol(currencyCode);

  const defaultCapacityValue = defaultCapacityInput.toInputs().capacityInput[interval];

  return (
    <div className="BudgetDonut">
      <div className="details">
        <div className="labeledDonuts">
          <div className="donuts">
            {isChildrenInfinite ? (
              <Donut
                data={[{ id: budgetLike.id, value: 1, color: "#666" }]}
                radius={73}
                thickness={7}
              />
            ) : (
              <>
                <Donut data={childrenDonutData} radius={60} thickness={10} />
                <Donut data={flatGrandChildrenDonutData} radius={50} thickness={10} />
              </>
            )}
          </div>
          <div className="centerLabel">
            {isChildrenInfinite && isSyncedInput ? (
              <div>Unlimited</div>
            ) : isSyncedInput ? (
              <div>
                <div>
                  {currencyCodeToSymbol(currencyCode)}&nbsp;
                  {numberToCommaString(syncingAmount, 0)}
                </div>
              </div>
            ) : (
              <div>
                {
                  <div>
                    <span>{currencyCodeToSymbol(currencyCode)}</span>
                    <CapacityInput
                      style={{ width: "7ch" }}
                      disabled={isSyncedInput}
                      defaultValue={defaultCapacityValue}
                      onBlur={onChangeAmount}
                    />
                  </div>
                }
                {!!parentDiff && (
                  <div className="colored alert">
                    {isChildrenInfinite ? (
                      <span>Unlimited</span>
                    ) : (
                      <>
                        <span>
                          {parentDiff < 0 ? "+" : "-"}&nbsp;{currencySymbol}&nbsp;
                        </span>
                        <span style={{ width: "7ch", textAlign: "center" }}>
                          {numberToCommaString(Math.abs(parentDiff), 0)}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {!isChildrenInfinite && (
          <CapacityBreakDown
            currencySymbol={currencySymbol}
            childrenDonutData={childrenDonutData}
            childToGrandChildrenMap={childToGrandChildrenMap}
          />
        )}
      </div>
    </div>
  );
};

export default BudgetDonut;
