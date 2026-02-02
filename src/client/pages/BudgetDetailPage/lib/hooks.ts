import { useMemo } from "react";
import { ViewDate } from "common";
import { Budget, AreaInput, GraphInput, LineInput, useAppContext } from "client";

export const useBudgetGraph = (budget: Budget) => {
  const { calculations, viewDate } = useAppContext();
  const { budgetData } = calculations;
  const { budget_id } = budget;
  const budgetHistory = budgetData.get(budget_id);

  const interval = viewDate.getInterval();
  const graphViewDate = useMemo(() => {
    const isFuture = new Date() < viewDate.getEndDate();
    return isFuture ? viewDate : new ViewDate(interval);
  }, [viewDate, interval]);

  const graphData: GraphInput = useMemo(() => {
    if (!budget) return {};

    const currentCapacity = budget.getActiveCapacity(graphViewDate.getEndDate());
    const isIncome = currentCapacity[interval] < 0;
    const sign = isIncome ? -1 : 1;

    const spendingHistory: number[] = budgetHistory
      .toArray(graphViewDate)
      .map(({ sorted_amount, unsorted_amount }) => sorted_amount + unsorted_amount);

    const { length } = spendingHistory;
    if (length < 2) return {};

    const lengthFixer = 3 - ((length - 1) % 3);

    let firstOccurence = false;
    for (let i = 0; i < length; i++) {
      if (spendingHistory[i] !== undefined) firstOccurence = true;
      if (!firstOccurence) continue;
      const e = spendingHistory[i];
      if (!e || e < 0) spendingHistory[i] = 0;
    }

    spendingHistory.push(...new Array(lengthFixer));
    spendingHistory.reverse();

    const clonedViewDate = graphViewDate.clone();
    const capacityHistory = new Array(length).fill(undefined).map(() => {
      const capacity = budget.getActiveCapacity(clonedViewDate.getEndDate());
      clonedViewDate.previous();
      return sign * capacity[interval];
    });

    capacityHistory.push(...new Array(lengthFixer).fill(capacityHistory[length - 1]));
    capacityHistory.reverse();

    const lines: LineInput[] = [
      { sequence: capacityHistory, color: "#aaa", type: "perpendicular" },
      { sequence: spendingHistory, color: "#097", type: "perpendicular" },
    ];

    const { roll_over, roll_over_start_date } = budget;

    if (!roll_over || !roll_over_start_date) return { lines };

    const upperBound = [];
    const lowerBound = [];
    const rollOverStartSpan = length - 1 - graphViewDate.getSpanFrom(roll_over_start_date);

    for (let i = rollOverStartSpan + lengthFixer; i < length + lengthFixer; i++) {
      if (spendingHistory[i] === undefined) continue;
      upperBound[i] = capacityHistory[i];
      lowerBound[i] = spendingHistory[i];
    }

    const areas: AreaInput[] = [
      {
        upperBound,
        lowerBound,
        color: "#a82",
        type: "perpendicular",
      },
    ];

    const todayIndex = graphViewDate.getSpanFrom(viewDate.getEndDate()) - lengthFixer + 1;
    const pointIndex = length - todayIndex;
    const pointValue = spendingHistory[pointIndex];
    const points = [];
    if (pointValue !== undefined) {
      points.push({ point: { value: pointValue, index: pointIndex }, color: "#097" });
    }

    return { lines, areas, points };
  }, [budget, budgetHistory, graphViewDate, interval, viewDate]);

  return { graphViewDate, graphData };
};
