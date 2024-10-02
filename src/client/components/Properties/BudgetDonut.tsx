import { Donut, adjustBrightness, useAppContext } from "client";
import { Category, Interval, MAX_FLOAT, getDateString, numberToCommaString } from "common";
import { DonutData } from "client/components";
import { BudgetLike } from "common/models/BudgetLike";

interface Props {
  budgetLike: BudgetLike;
  date: Date;
}

const colors = [
  "#22AB6C",
  "#784E30",
  "#5D9B7E",
  "#786130",
  "#43656D",
  "#2E8089",
  "#AB7E22",
  "#AB5C22",
  "#DE9600",
  "#00DE78",
];

const altDescendingSort = (budgetLikes: BudgetLike[], date: Date, interval: Interval) => {
  const sorted = [...budgetLikes].sort((a, b) => {
    return a.getActiveCapacity(date)[interval] - b.getActiveCapacity(date)[interval];
  });

  const half = Math.ceil(sorted.length / 2);
  const firstHalf = sorted.slice(0, half);
  const secondHalf = sorted.slice(half);

  const result = [];
  for (let i = 0; i < firstHalf.length; i++) {
    result.push(firstHalf[i]);
    if (i < secondHalf.length) result.push(secondHalf[i]);
  }

  return result;
};

const BudgetDonut = ({ budgetLike, date }: Props) => {
  const { viewDate } = useAppContext();
  const interval = viewDate.getInterval();
  const children = altDescendingSort(budgetLike.getChildren(), date, interval);

  const childrenDonutData: DonutData[] = [];
  const grandChildrenDonutData: DonutData[] = [];

  let isChildrenInfinite = false;
  let childrenTotal = 0;

  children.forEach((child, i) => {
    const childValue = child.getActiveCapacity(date)[interval];
    isChildrenInfinite = Math.abs(childValue) === MAX_FLOAT;
    childrenTotal += childValue;

    childrenDonutData.push({
      value: childValue,
      color: colors[i % colors.length],
      label: child.name || "Unnamed",
    });

    let grandChildrenTotal = 0;
    const grandChildren = child.getChildren() as Category[];

    grandChildren.forEach((grandChild, j) => {
      const brightness = ((j % 2) + 1) * 0.3 + 1;
      const color = adjustBrightness(colors[i % colors.length], brightness);
      const grandChildValue = grandChild.getActiveCapacity(date)[interval];
      isChildrenInfinite = Math.abs(grandChildValue) === MAX_FLOAT;
      grandChildrenTotal += grandChildValue;
      grandChildrenDonutData.push({
        value: grandChildValue,
        color: color,
        label: grandChild.name || "Unnamed",
      });
    });

    if (childValue > grandChildrenTotal) {
      childrenDonutData.push({
        value: childValue - grandChildrenTotal,
        color: "#fff0",
      });
    } else {
      grandChildrenDonutData.push({
        value: grandChildrenTotal - childValue,
        color: "#fff0",
      });
    }
  });

  const totalCapacityAmount = budgetLike.getActiveCapacity(date)[interval];
  const isParentInfinite = Math.abs(totalCapacityAmount) === MAX_FLOAT;
  const parentDonutData: DonutData[] = [{ value: totalCapacityAmount, color: "#fff0" }];
  if (childrenTotal > totalCapacityAmount) {
    parentDonutData.push({ value: childrenTotal - totalCapacityAmount, color: "#fff0" });
  } else if (childrenTotal < totalCapacityAmount) {
    childrenDonutData.push({ value: totalCapacityAmount - childrenTotal, color: "#fff0" });
    grandChildrenDonutData.push({ value: totalCapacityAmount - childrenTotal, color: "#fff0" });
  }
  const centerLabel = numberToCommaString(totalCapacityAmount);

  if (isChildrenInfinite || isParentInfinite) {
    // TODO: What should I display here?
    return (
      <div className="BudgetDonut">
        <Donut data={[{ value: 1, color: "#888" }]} />
      </div>
    );
  }

  const capacityBreakDown = childrenDonutData.map((d, i) => {
    return (
      <tr key={i} className={d.label ? undefined : "colored alert"}>
        <td>{d.label || "Not Specified"}</td>
        <td>$&nbsp;{numberToCommaString(d.value)}</td>
      </tr>
    );
  });

  return (
    <div className="BudgetDonut">
      <div className="details">
        <div className="labeledDonuts">
          <div className="donuts">
            <Donut data={childrenDonutData} radius={80} />
            <Donut data={grandChildrenDonutData} radius={60} />
          </div>
          <div className="centerLabel">$&nbsp;{centerLabel}</div>
        </div>
        <div className="capacityBreakDown">
          <table style={{ width: "100%" }}>
            <tbody>{capacityBreakDown}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default BudgetDonut;
