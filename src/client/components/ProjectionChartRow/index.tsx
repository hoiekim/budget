import { Dispatch, MouseEventHandler, SetStateAction, useMemo } from "react";
import { getYearMonthString, numberToCommaString, ViewDate } from "common";
import { useAccountGraph, useAppContext, useReorder, ProjectionChart } from "client";
import { ChevronDownIcon, ChevronUpIcon, DateLabel, Graph, MoneyLabel } from "client/components";
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

  const {
    onDragStart,
    onDragEnd,
    onDragEnter,
    onGotPointerCapture,
    onTouchHandleStart,
    onTouchHandleEnd,
    onPointerEnter,
    isDragging,
  } = useReorder(chart.id, onSetOrder);

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
    while (!!savingViewDate.getStartDate().getMonth()) {
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

  if (!account_ids?.length) {
    return (
      <div className="ProjectionChartRow" onClick={onClick}>
        {showTitle && <div className="title">{chart.name}</div>}
        <Graph height={200} input={{}} />
      </div>
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

  const classes = ["ProjectionChartRow"];
  if (isDragging) classes.push("dragging");

  return (
    <div
      className={classes.join(" ")}
      onClick={onClick}
      draggable={true}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onPointerEnter={onPointerEnter}
      onDragEnd={onDragEnd}
    >
      {showTitle && (
        <h3 className="title">
          <span>{chart.name}</span>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onTouchStart={onTouchHandleStart}
            onTouchEnd={onTouchHandleEnd}
            onGotPointerCapture={onGotPointerCapture}
            style={{ touchAction: "none" }}
          >
            <div className="reorderIcon">
              <ChevronUpIcon size={8} />
              <ChevronDownIcon size={8} />
            </div>
          </button>
        </h3>
      )}
      <Graph
        height={150}
        input={graphData}
        labelX={new DateLabel(latestViewDate, { year: "numeric", month: undefined })}
        labelY={new MoneyLabel("USD")}
      />
      {showTable && (
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
      )}
    </div>
  );
};
