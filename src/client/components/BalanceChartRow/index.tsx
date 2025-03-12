import { MouseEventHandler } from "react";
import { AccountType } from "plaid";
import { BalanceChart, numberToCommaString } from "common";
import { useAppContext } from "client";
import { ColumnData, StackData, Stacks } from "./Stacks";
import "./index.css";

export interface BalanceChartRowProps {
  showTitle?: boolean;
  chart: BalanceChart;
  onClick?: MouseEventHandler<HTMLDivElement>;
}

export const BalanceChartRow = ({ showTitle = true, chart, onClick }: BalanceChartRowProps) => {
  const { data } = useAppContext();
  const { accounts, budgets } = data;
  const { name, configuration } = chart;

  const column1: StackData[] = [];
  const column2: StackData[] = [];

  accounts.forEach((a) => {
    const stack = { name: a.custom_name || a.name, amount: a.balances.current || 0 };
    if (!configuration.account_ids.includes(a.id)) return;
    if (a.type === AccountType.Depository) column1.push(stack);
    else if (a.type === AccountType.Investment) column1.push(stack);
    else if (a.type === AccountType.Credit) column2.push(stack);
    else if (a.type === AccountType.Loan) column2.push(stack);
  });

  budgets.forEach((b) => {
    const stack = { name: b.name, amount: -b.rolled_over_amount };
    if (!configuration.budget_ids.includes(b.id)) return;
    if (b.rolled_over_amount > 0) return column1.push(stack);
    else column2.push(stack);
  });

  const stacksData: ColumnData[] = [column1, column2];

  const sum1 = stacksData[0].reduce((acc, { amount }) => acc + amount, 0);
  const sum2 = stacksData[1].reduce((acc, { amount }) => acc - amount, 0);

  const total = sum1 + sum2;
  const sign = total >= 0 ? "+" : "-";

  return (
    <div className="BalanceChartRow" onClick={onClick}>
      {showTitle && <div className="title">{name}</div>}
      <div className="chart">
        <Stacks data={stacksData} />
        <div className="equation">
          <div className="equationItem">+&nbsp;$&nbsp;{numberToCommaString(Math.abs(sum1), 0)}</div>
          <div className="equationItem">-&nbsp;$&nbsp;{numberToCommaString(Math.abs(sum2), 0)}</div>
          <hr />
          <div className="equationItem">
            {sign}&nbsp;$&nbsp;{numberToCommaString(Math.abs(total), 0)}
          </div>
        </div>
      </div>
    </div>
  );
};

export * from "./Stacks";
