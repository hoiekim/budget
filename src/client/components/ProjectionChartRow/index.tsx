import { Dispatch, MouseEventHandler, SetStateAction, useMemo, useRef } from "react";
import {
  getYearMonthString,
  numberToCommaString,
  numberToCompactString,
  ViewDate,
} from "common";
import {
  useAccountGraph,
  useAppContext,
  useCompactWhenOverflowing,
  useGoalConfig,
  ProjectionChart,
  inferSavingConfig,
  ScreenType,
} from "client";
import { ChartRowShell, DateLabel, Graph, MoneyLabel } from "client/components";
import { calculateProjection } from "./lib";
import "./index.css";

export interface ProjectionChartRowProps {
  chart: ProjectionChart;
  showTitle?: boolean;
  showTable?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

export const ProjectionChartRow = ({
  showTitle = true,
  showTable = true,
  chart,
  onClick,
  onSetOrder,
}: ProjectionChartRowProps) => {
  const { data, calculations, screenType } = useAppContext();
  const { accounts } = data;

  const tableRef = useRef<HTMLTableElement>(null);
  const compact = useCompactWhenOverflowing(tableRef);
  const money = (n: number) =>
    compact ? `$${numberToCompactString(n)}` : `$ ${numberToCommaString(n, 0)}`;
  const scenarioName = screenType === ScreenType.Narrow ? "scenarioName visuallyHidden" : "scenarioName";
  const { configuration } = chart;
  const { account_ids, auto_saving_config } = configuration;
  const { living_cost, year_over_year_inflation } = useGoalConfig(configuration);

  const savingConfig = auto_saving_config
    ? inferSavingConfig(calculations.balanceData, account_ids, new ViewDate("month"))
    : configuration;

  const { initial_saving, contribution, anual_percentage_yield } = savingConfig;

  const selectedAccounts = accounts.filter((a) => {
    const isIncluded = account_ids.includes(a.id);
    const isHidden = a.hide;
    return isIncluded && !isHidden;
  });

  const momInflation = Math.pow(year_over_year_inflation, 1 / 12);
  const mpy = Math.pow(anual_percentage_yield, 1 / 12);

  const adjustedInitialSaving = useMemo(() => {
    const saving = { ...initial_saving };
    const savingViewDate = new ViewDate("month", saving.amountAsOf);
    while (savingViewDate.getStartDate().getMonth()) {
      saving.amount /= momInflation;
      savingViewDate.previous();
    }
    saving.amountAsOf = savingViewDate.getEndDate();
    return saving;
  }, [initial_saving, momInflation]);

  const startDate = adjustedInitialSaving.amountAsOf;

  const { graphViewDate, graphData } = useAccountGraph(selectedAccounts, {
    startDate,
    viewDate: new ViewDate("month"),
    useLengthFixer: false,
  });

  // Guard on the list actually graphed, not the stored `account_ids`:
  // every referenced account may be hidden or deleted while the ids
  // survive, and graphing an empty selection throws in
  // `calculateProjection` (startOffset -1 -> new Array(-1)).
  if (!selectedAccounts.length) {
    return (
      <ChartRowShell
        className="ProjectionChartRow"
        chart={chart}
        showTitle={showTitle}
        onClick={onClick}
        onSetOrder={onSetOrder}
      >
        <Graph height={200} input={{}} />
      </ChartRowShell>
    );
  }

  const currentViewDate = graphViewDate.clone();

  const historyLine = graphData.lines![0];

  const { sequence } = historyLine;
  const lastValue = sequence[sequence.length - 1] as number;

  const {
    graphData: { lines: planProjectionLines, points: planRetirePoints },
    graphViewDate: planGraphViewDate,
    retireDate: planRetireDate,
    retireAmount: planRetireAmount,
  } = calculateProjection({
    lineColor: "#aaa",
    pointColor: "#aaa",
    startDate,
    initialSaving: initial_saving,
    livingCost: living_cost,
    contribution,
    anualPercentageYield: anual_percentage_yield,
    yearOverYearInflation: year_over_year_inflation,
  });

  graphData.lines!.push(...planProjectionLines);
  graphData.points!.push(...planRetirePoints);

  const {
    graphData: { lines: currentProjectionLines, points: currentRetirePoint },
    graphViewDate: currentGraphViewDate,
    retireDate: currentRetireDate,
    retireAmount: currentRetireAmount,
  } = calculateProjection({
    lineColor: "#097",
    pointColor: "#f43",
    startOffset: sequence.length - 1,
    startDate: graphViewDate.clone().getEndDate(),
    endDate: planGraphViewDate.getEndDate(),
    initialSaving: { amount: lastValue, amountAsOf: graphViewDate.getEndDate() },
    livingCost: living_cost,
    contribution,
    anualPercentageYield: anual_percentage_yield,
    yearOverYearInflation: year_over_year_inflation,
  });

  graphData.lines!.push(...currentProjectionLines);
  graphData.points!.push(...currentRetirePoint);

  const latestViewDate =
    currentGraphViewDate.getEndDate() < planGraphViewDate.getEndDate()
      ? planGraphViewDate
      : currentGraphViewDate;

  while ((latestViewDate.getEndDate().getFullYear() - startDate.getFullYear()) % 6) {
    graphData.lines!.forEach(({ sequence }, i) => {
      if (!i) return;
      const lastValue = sequence[sequence.length - 1];
      if (!lastValue) return;
      sequence.push(lastValue * momInflation);
    });
    latestViewDate.next();
  }

  return (
    <ChartRowShell
      className="ProjectionChartRow"
      chart={chart}
      showTitle={showTitle}
      onClick={onClick}
      onSetOrder={onSetOrder}
    >
      <Graph
        height={150}
        input={graphData}
        labelX={new DateLabel(latestViewDate, { year: "numeric", month: undefined })}
        labelY={new MoneyLabel("USD")}
      />
      {showTable && (
        <table width="100%" ref={tableRef}>
          <thead>
            <tr>
              <th className="scenario">
                <span className={scenarioName}>Scenario</span>
              </th>
              <th>Date</th>
              <th>Saved</th>
              <th>Payout Max</th>
            </tr>
            <tr className="spacer"></tr>
          </thead>
          <tbody>
            <tr>
              <td className="scenario">
                <div className="label colored" style={{ backgroundColor: "#097" }} />
                <span className={scenarioName}>Now</span>
              </td>
              <td>{getYearMonthString(currentViewDate.getStartDate())}</td>
              <td>{money(lastValue)}</td>
              <td>{money(lastValue * (mpy - momInflation))}</td>
            </tr>
            {!!currentRetireDate && !!currentRetireAmount && (
              <tr>
                <td className="scenario">
                  <div className="label colored" style={{ backgroundColor: "#f43" }} />
                  <span className={scenarioName}>Trajectory</span>
                </td>
                <td>{getYearMonthString(currentRetireDate)}</td>
                <td>{money(currentRetireAmount)}</td>
                <td>{money(currentRetireAmount * (mpy - momInflation))}</td>
              </tr>
            )}
            {!!planRetireDate && !!planRetireAmount && (
              <tr>
                <td className="scenario">
                  <div className="label" style={{ backgroundColor: "#aaa" }} />
                  <span className={scenarioName}>Plan</span>
                </td>
                <td>{getYearMonthString(planRetireDate)}</td>
                <td>{money(planRetireAmount)}</td>
                <td>{money(planRetireAmount * (mpy - momInflation))}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </ChartRowShell>
  );
};
