import { AmountInTime, ViewDate } from "common";
import { LineInput, PointInput } from "client";

export interface ProjectionCalculationResult {
  graphViewDate: ViewDate;
  graphData: {
    lines: LineInput[];
    points: PointInput[];
  };
  retireDate?: Date;
  retireAmount?: number;
}

export interface ProjectionConfig {
  lineColor: string;
  pointColor: string;
  startDate: Date;
  endDate?: Date;
  startOffset?: number;
  initialSaving: AmountInTime;
  livingCost: AmountInTime;
  contribution: number;
  anualPercentageYield: number;
  yearOverYearInflation: number;
}

export const calculateProjection = (config: ProjectionConfig): ProjectionCalculationResult => {
  const {
    lineColor,
    pointColor,
    startDate,
    endDate,
    startOffset = 0,
    initialSaving,
    livingCost,
    contribution,
    anualPercentageYield,
    yearOverYearInflation,
  } = config;

  const monthlyPercentageYield = Math.pow(anualPercentageYield, 1 / 12);
  const monthOverMonthInflation = Math.pow(yearOverYearInflation, 1 / 12);

  const line: LineInput = {
    sequence: [...new Array(startOffset), initialSaving.amount],
    color: lineColor,
    strokeType: "dashed",
  };

  line.sequence.push(initialSaving.amount);

  let inflatedLivingCost = livingCost.amount / (1 - (livingCost.taxRate || 0));
  const livingCostPastSpan = new ViewDate("month", livingCost.amountAsOf).getSpanFrom(startDate);

  for (let i = 0; i < Math.abs(livingCostPastSpan); i++) {
    if (livingCostPastSpan < 0) {
      inflatedLivingCost *= monthOverMonthInflation;
    } else {
      inflatedLivingCost /= monthOverMonthInflation;
    }
  }

  let savedAmount = initialSaving.amount;
  const viewDate = new ViewDate("month", startDate);

  // calculate monthly progress until retirement
  while (savedAmount * (monthlyPercentageYield - monthOverMonthInflation) < inflatedLivingCost) {
    savedAmount = savedAmount * monthlyPercentageYield + contribution;
    line.sequence.push(savedAmount);
    inflatedLivingCost *= monthOverMonthInflation;
    viewDate.next();
  }

  const retireDate = viewDate.clone().getStartDate();
  const retireAmount = savedAmount;

  const point: PointInput = {
    point: { value: savedAmount, index: line.sequence.length - 1 },
    color: pointColor,
    guideX: true,
    guideY: false,
  };

  // adds 5% padding after the retire point
  for (let i = 0; i < line.sequence.length / 20; i++) {
    savedAmount = savedAmount * monthOverMonthInflation;
    line.sequence.push(savedAmount);
    viewDate.next();
  }

  // makes sure specified endDate is covered
  while (endDate && viewDate.getEndDate() <= endDate) {
    savedAmount = savedAmount * monthOverMonthInflation;
    line.sequence.push(savedAmount);
    viewDate.next();
  }

  // makes sure the period ends on January
  while (viewDate.getEndDate().getMonth() !== 0) {
    savedAmount = savedAmount * monthOverMonthInflation;
    line.sequence.push(savedAmount);
    viewDate.next();
  }

  return {
    graphViewDate: viewDate,
    graphData: { lines: [line], points: [point] },
    retireDate,
    retireAmount,
  };
};
