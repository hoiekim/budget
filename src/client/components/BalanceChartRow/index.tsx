import { MouseEventHandler } from "react";
import { AccountType } from "plaid";
import { BalanceChart, numberToCommaString, toTitleCase } from "common";
import { useAppContext } from "client";
import { ColumnData, StackData, Stacks } from "./Stacks";
import "./index.css";

export interface BalanceChartRowProps {
  showTitle?: boolean;
  chart: BalanceChart;
  onClick?: MouseEventHandler<HTMLDivElement>;
}

export const BalanceChartRow = ({ showTitle = true, chart, onClick }: BalanceChartRowProps) => {
  const { data, viewDate } = useAppContext();
  const { accounts, budgets } = data;
  const { name, configuration } = chart;

  const column1: StackData[] = [];
  const column2: StackData[] = [];

  accounts.forEach((a) => {
    const stack = { type: a.type, name: a.custom_name || a.name, amount: a.balances.current || 0 };
    if (!configuration.account_ids.includes(a.id)) return;
    if (a.type === AccountType.Depository) column1.push(stack);
    else if (a.type === AccountType.Investment) column1.push(stack);
    else if (a.type === AccountType.Credit) column2.push(stack);
    else if (a.type === AccountType.Loan) column2.push(stack);
  });

  budgets.forEach((b) => {
    if (!configuration.budget_ids.includes(b.id)) return;
    const date = viewDate.getEndDate();
    const interval = viewDate.getInterval();
    const amount = b.roll_over ? b.rolled_over_amount : -b.getActiveCapacity(date)[interval];
    const stack = { type: "Budget", name: b.name, amount: Math.abs(amount) };
    if (amount > 0) return column1.push(stack);
    else column2.push(stack);
  });

  const stacksData: ColumnData[] = [column1, column2];
  stacksData.forEach((column) => {
    column.sort((a, b) => b.amount - a.amount);
  });

  const sum1 = stacksData[0].reduce((acc, { amount }) => acc + amount, 0);
  const sum2 = stacksData[1].reduce((acc, { amount }) => acc - amount, 0);

  const total = sum1 + sum2;
  const sign = total >= 0 ? "" : "-";

  const tableRows1 = column1.map(({ type, name, amount }, i) => {
    const amountString = numberToCommaString(amount, 0);
    return (
      <tr key={`${i}_${name}`}>
        <td>{toTitleCase(type)}</td>
        <td>{name}</td>
        <td>$&nbsp;{amountString}</td>
      </tr>
    );
  });

  const tableRows2 = column2.map(({ type, name, amount }, i) => {
    const amountString = numberToCommaString(amount, 0);
    return (
      <tr key={`${i}_${name}`}>
        <td>{type}</td>
        <td>{name}</td>
        <td>-&nbsp;$&nbsp;{amountString}</td>
      </tr>
    );
  });

  return (
    <div className="BalanceChartRow" onClick={onClick}>
      {showTitle && <h3 className="title">{name}</h3>}
      <div className="chart">
        <Stacks data={stacksData} />
        <div className="equation">
          <div className="equationItem">$&nbsp;{numberToCommaString(Math.abs(sum1), 0)}</div>
          <div className="equationItem">-&nbsp;$&nbsp;{numberToCommaString(Math.abs(sum2), 0)}</div>
          <hr />
          <div className="equationItem">
            {sign}&nbsp;$&nbsp;{numberToCommaString(Math.abs(total), 0)}
          </div>
        </div>
      </div>
      <table width="100%">
        <thead>
          <tr>
            <th>Type</th>
            <th>Name</th>
            <th>Balance</th>
          </tr>
          <tr className="spacer"></tr>
        </thead>
        <tbody>
          {tableRows1}
          {tableRows2}
          <tr className="spacer"></tr>
          <tr className="sum">
            <td colSpan={2}>Sum</td>
            <td>
              {sign}&nbsp;$&nbsp;{numberToCommaString(Math.abs(total), 0)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

export * from "./Stacks";
