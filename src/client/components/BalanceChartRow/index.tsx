import { Dispatch, KeyboardEvent, MouseEventHandler, SetStateAction } from "react";
import { AccountType } from "plaid";
import { numberToCommaString, toTitleCase } from "common";
import { BalanceChart, getDisplayBalance, useAppContext } from "client";
import { ChartRowShell, QuestionIcon } from "client/components";
import { ColumnData, StackData, Stacks } from "./Stacks";
import "./index.css";

export interface BalanceChartRowProps {
  chart: BalanceChart;
  showTitle?: boolean;
  showTable?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

export const BalanceChartRow = ({
  chart,
  showTitle = true,
  showTable = true,
  onClick,
  onSetOrder,
}: BalanceChartRowProps) => {
  const { data, calculations, viewDate } = useAppContext();
  const { accounts, budgets } = data;
  const { budgetData, balanceData } = calculations;
  const { configuration } = chart;

  const date = viewDate.getEndDate();
  const today = new Date();
  const interval = viewDate.getInterval();

  const column1: StackData[] = [];
  const column2: StackData[] = [];

  accounts.forEach((a) => {
    if (a.hide) return;
    // Use historical balance for the selected view date so that switching
    // to a past month reflects the balance at that time rather than today's
    // live Plaid balance. While the cold-load history is still streaming,
    // fall back to the live balance instead of flashing $0 (#510).
    const historicalBalance = getDisplayBalance(balanceData, a, date, today, data.status.isLoading);
    const stack = { type: a.type, name: a.custom_name || a.name, amount: historicalBalance };
    if (!configuration.account_ids.includes(a.id)) return;
    // Plaid AccountType: Depository, Investment, Brokerage are assets;
    // Credit and Loan are liabilities. `Other` is "non-specified" per
    // Plaid's docs — drop it rather than guessing a polarity.
    if (
      a.type === AccountType.Depository ||
      a.type === AccountType.Investment ||
      a.type === AccountType.Brokerage
    ) {
      column1.push(stack);
    } else if (a.type === AccountType.Credit || a.type === AccountType.Loan) {
      column2.push(stack);
    }
  });

  budgets.forEach((b) => {
    if (!configuration.budget_ids.includes(b.id)) return;
    // Rollover projects forward for future views (#562); capacity already does.
    const amount = b.roll_over
      ? budgetData.getRolledOver(b, date)
      : -b.getActiveAmount(date, interval);
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
    const isOverspentBudget = type === "Budget";
    const onClickOverspentBudget = () => {
      if (isOverspentBudget) {
        window.alert(
          `You overspent $${amountString} for the budget "${name}". We're displaying overspent amount stacked together with the deposit amounts because it's the amount that would have been in the depositories.`,
        );
      }
    };
    return (
      <tr
        key={`${i}_${name}`}
        onClick={onClickOverspentBudget}
        onKeyDown={
          isOverspentBudget
            ? (e: KeyboardEvent<HTMLTableRowElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClickOverspentBudget();
                }
              }
            : undefined
        }
        role={isOverspentBudget ? "button" : undefined}
        tabIndex={isOverspentBudget ? 0 : undefined}
        aria-label={isOverspentBudget ? `Overspent budget: ${name}` : undefined}
      >
        <td className="type">
          {toTitleCase(type)}
          {isOverspentBudget && (
            <>
              &nbsp;
              <QuestionIcon size={12} />
            </>
          )}
        </td>
        <td>{name}</td>
        <td>$&nbsp;{amountString}</td>
      </tr>
    );
  });

  const tableRows2 = column2.map(({ type, name, amount }, i) => {
    const amountString = numberToCommaString(amount, 0);
    return (
      <tr key={`${i}_${name}`}>
        <td>{toTitleCase(type)}</td>
        <td>{name}</td>
        <td>-&nbsp;$&nbsp;{amountString}</td>
      </tr>
    );
  });

  return (
    <ChartRowShell
      className="BalanceChartRow"
      chart={chart}
      showTitle={showTitle}
      onClick={onClick}
      onSetOrder={onSetOrder}
    >
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
      {showTable && (
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
      )}
    </ChartRowShell>
  );
};

export * from "./Stacks";
