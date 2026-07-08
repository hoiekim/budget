import { Dispatch, MouseEventHandler, SetStateAction, useMemo } from "react";
import { useAppContext, useReorder, FlowChart } from "client";
import { ChartRowTitle } from "client/components";
import { getSankeyData } from "./lib";
import { Sankey } from "./Sankey";
import "./index.css";
import { numberToCommaString } from "common";

export interface FlowChartRowProps {
  chart: FlowChart;
  showTitle?: boolean;
  showTable?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
  height?: number;
}

export const FlowChartRow = ({
  showTitle = true,
  showTable = true,
  chart,
  onClick,
  onSetOrder,
  height = 150,
}: FlowChartRowProps) => {
  const { data, viewDate } = useAppContext();
  const {
    accounts,
    transactions,
    investmentTransactions,
    splitTransactions,
    budgets,
    sections,
    categories,
    transfers,
  } = data;
  const { configuration } = chart;
  const { account_ids, budget_ids } = configuration;

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

  const { graphData, tableData } = useMemo(
    () =>
      getSankeyData(
        selectedAccounts,
        transactions,
        investmentTransactions,
        splitTransactions,
        budgets,
        sections,
        categories,
        viewDate,
        transfers,
        budget_ids,
      ),
    [
      selectedAccounts,
      transactions,
      investmentTransactions,
      splitTransactions,
      budgets,
      sections,
      categories,
      viewDate,
      transfers,
      budget_ids,
    ],
  );

  const { income, expense } = tableData;
  const diff = income - expense;

  const classes = ["FlowChartRow"];
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
        <ChartRowTitle
          name={chart.name}
          onTouchHandleStart={onTouchHandleStart}
          onTouchHandleEnd={onTouchHandleEnd}
          onGotPointerCapture={onGotPointerCapture}
        />
      )}
      <Sankey memoryKey={chart.id} data={graphData} height={height} />
      {showTable && (
        <table width="100%">
          <thead>
            <tr>
              <th>In</th>
              <th>Out</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={2}>
                <hr />
              </td>
            </tr>
            <tr>
              <td>$&nbsp;{numberToCommaString(income)}</td>
              <td>$&nbsp;{numberToCommaString(expense)}</td>
            </tr>
            <tr>
              <td colSpan={2}>
                <hr />
              </td>
            </tr>
            <tr>
              <td className="colored" style={{ color: "#f43" }}>
                {diff > 0 ? undefined : `$ ${numberToCommaString(Math.abs(diff))}`}
              </td>
              <td className="colored" style={{ color: "#097" }}>
                {diff > 0 ? `$ ${numberToCommaString(Math.abs(diff))}` : undefined}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
};
