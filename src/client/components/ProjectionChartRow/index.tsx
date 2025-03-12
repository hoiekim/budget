import { MouseEventHandler, useMemo } from "react";
import { getYearMonthString, numberToCommaString, ProjectionChart, ViewDate } from "common";
import { useAppContext } from "client";
import { DateLabel, Graph, MoneyLabel } from "client/components";
import { calculateHistory, calculateProjection } from "./lib";
import "./index.css";

export interface ProjectionChartRowProps {
  showTitle?: boolean;
  chart: ProjectionChart;
  onClick?: MouseEventHandler<HTMLDivElement>;
}

export const ProjectionChartRow = ({
  showTitle = true,
  chart,
  onClick,
}: ProjectionChartRowProps) => {
  const { data } = useAppContext();
  const { accounts } = data;
  const { configuration } = chart;
  const {
    account_ids,
    initial_saving,
    contribution,
    living_cost,
    anual_percentage_yield,
    year_over_year_inflation,
  } = configuration;

  const selectedAccounts = accounts.filter((a) => account_ids.includes(a.id));
  const momInflation = Math.pow(year_over_year_inflation, 1 / 12);
  const mpy = Math.pow(anual_percentage_yield, 1 / 12);

  const adjustedInitialSaving = useMemo(() => {
    const saving = { ...initial_saving };
    const savingViewDate = new ViewDate("month", saving.amountAsOf);
    while (!!savingViewDate.getStartDate().getMonth()) {
      saving.amount /= momInflation;
      savingViewDate.previous();
    }
    saving.amountAsOf = savingViewDate.getEndDate();
    return saving;
  }, []);

  if (!account_ids?.length) {
    return (
      <div className="ProjectionChartRow" onClick={onClick}>
        {showTitle && <div className="title">{chart.name}</div>}
        <Graph height={200} input={{}} />
      </div>
    );
  }

  const { graphViewDate, graphData } = calculateHistory(selectedAccounts, data, {
    startDate: adjustedInitialSaving.amountAsOf,
    lineColor: "#097",
    pointColor: "#097",
  });

  const currentViewDate = graphViewDate.clone();

  const historyLine = graphData.lines[0];

  const { sequence } = historyLine;
  const lastValue = sequence[sequence.length - 1] as number;
  const historyStartDate = graphViewDate.clone().previous(sequence.length + 1);

  while (historyStartDate.getStartDate() < adjustedInitialSaving.amountAsOf) {
    historyLine.sequence.shift();
    historyStartDate.next();
  }

  while (historyStartDate.getStartDate() > adjustedInitialSaving.amountAsOf) {
    historyLine.sequence.unshift(undefined);
    historyStartDate.previous();
  }

  const {
    graphData: { lines: planProjectionLines, points: planRetirePoints },
    graphViewDate: planGraphViewDate,
    retireDate: planRetireDate,
    retireAmount: planRetireAmount,
  } = calculateProjection({
    lineColor: "#aaa",
    pointColor: "#aaa",
    startDate: adjustedInitialSaving.amountAsOf,
    initialSaving: adjustedInitialSaving,
    livingCost: living_cost,
    contribution,
    anualPercentageYield: anual_percentage_yield,
    yearOverYearInflation: year_over_year_inflation,
  });

  graphData.lines.push(...planProjectionLines);
  graphData.points.push(...planRetirePoints);

  const {
    graphData: { lines: currentProjectionLines, points: currentRetirePoint },
    graphViewDate: currentGraphViewDate,
    retireDate: currentRetireDate,
    retireAmount: currentRetireAmount,
  } = calculateProjection({
    lineColor: "#097",
    pointColor: "#f43",
    startOffset: sequence.length,
    startDate: graphViewDate.getStartDate(),
    endDate: planGraphViewDate.getEndDate(),
    initialSaving: { amount: lastValue, amountAsOf: graphViewDate.getStartDate() },
    livingCost: configuration.living_cost,
    contribution: configuration.contribution,
    anualPercentageYield: configuration.anual_percentage_yield,
    yearOverYearInflation: configuration.year_over_year_inflation,
  });

  graphData.lines.push(...currentProjectionLines);
  graphData.points.push(...currentRetirePoint);

  const latestViewDate =
    currentGraphViewDate.getEndDate() < planGraphViewDate.getEndDate()
      ? planGraphViewDate
      : currentGraphViewDate;

  while (
    (latestViewDate.getEndDate().getFullYear() - adjustedInitialSaving.amountAsOf.getFullYear()) %
    6
  ) {
    graphData.lines.forEach(({ sequence }, i) => {
      if (!i) return;
      const lastValue = sequence[sequence.length - 1];
      if (!lastValue) return;
      sequence.push(lastValue * momInflation);
    });
    latestViewDate.next();
  }

  return (
    <div className="ProjectionChartRow" onClick={onClick}>
      {showTitle && <h3 className="title">{chart.name}</h3>}
      <Graph
        height={200}
        input={graphData}
        labelX={new DateLabel(latestViewDate, { year: "numeric", month: undefined })}
        labelY={new MoneyLabel("USD")}
      />
      <table width="100%">
        <thead>
          <tr>
            <th></th>
            <th>Date</th>
            <th>Saved</th>
            <th>Payout Max</th>
          </tr>
          <tr className="spacer"></tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <div className="label colored" style={{ backgroundColor: "#097" }} />
            </td>
            <td>{getYearMonthString(currentViewDate.getStartDate())}</td>
            <td>$ {numberToCommaString(lastValue, 0)}</td>
            <td>$ {numberToCommaString(lastValue * (mpy - momInflation), 0)}</td>
          </tr>
          {!!currentRetireDate && !!currentRetireAmount && (
            <tr>
              <td>
                <div className="label colored" style={{ backgroundColor: "#f43" }} />
              </td>
              <td>{getYearMonthString(currentRetireDate)}</td>
              <td>$ {numberToCommaString(currentRetireAmount, 0)}</td>
              <td>$ {numberToCommaString(currentRetireAmount * (mpy - momInflation), 0)}</td>
            </tr>
          )}
          {!!planRetireDate && !!planRetireAmount && (
            <tr>
              <td>
                <div className="label" style={{ backgroundColor: "#aaa" }} />
              </td>
              <td>{getYearMonthString(planRetireDate)}</td>
              <td>$ {numberToCommaString(planRetireAmount, 0)}</td>
              <td>$ {numberToCommaString(planRetireAmount * (mpy - momInflation), 0)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};
