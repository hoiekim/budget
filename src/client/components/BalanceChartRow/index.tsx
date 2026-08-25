import { Dispatch, KeyboardEvent, MouseEventHandler, SetStateAction } from "react";
import { AccountType } from "plaid";
import { numberToCommaString, toTitleCase } from "common";
import { BalanceChart, getDisplayBalance, useAppContext } from "client";
import { ChartRowShell, QuestionIcon } from "client/components";
import { ColumnData, StackData, Stacks } from "./Stacks";
import { AnnotatedStack, getBudgetColumns } from "./lib";
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

  const accountAssets: StackData[] = [];
  const accountLiabilities: StackData[] = [];

  accounts.forEach((a) => {
    if (a.hide) return;
    // Use historical balance for the selected view date so that switching
    // to a past month reflects the balance at that time rather than today's
    // live Plaid balance. While the cold-load history is still streaming,
    // fall back to the live balance instead of flashing $0.
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
      accountAssets.push(stack);
    } else if (a.type === AccountType.Credit || a.type === AccountType.Loan) {
      accountLiabilities.push(stack);
    }
  });

  const budgetColumns = getBudgetColumns(
    budgets.toArray(),
    configuration.budget_ids,
    budgetData.getRolledOver,
    date,
    interval,
  );
  const column1: AnnotatedStack[] = [...accountAssets, ...budgetColumns.assets];
  const column2: AnnotatedStack[] = [...accountLiabilities, ...budgetColumns.liabilities];

  const stacksData: ColumnData[] = [column1, column2];
  stacksData.forEach((column) => {
    column.sort((a, b) => b.amount - a.amount);
  });

  const sum1 = stacksData[0].reduce((acc, { amount }) => acc + amount, 0);
  const sum2 = stacksData[1].reduce((acc, { amount }) => acc - amount, 0);

  const total = sum1 + sum2;
  const sign = total >= 0 ? "" : "-";

  const tableRows1 = column1.map(({ type, name, amount, note }, i) => {
    const amountString = numberToCommaString(amount, 0);
    const isExplained = note !== undefined;
    const onClickExplain = () => {
      if (note) window.alert(note.message);
    };
    return (
      <tr
        key={`${i}_${name}`}
        onClick={onClickExplain}
        onKeyDown={
          isExplained
            ? (e: KeyboardEvent<HTMLTableRowElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClickExplain();
                }
              }
            : undefined
        }
        role={isExplained ? "button" : undefined}
        tabIndex={isExplained ? 0 : undefined}
        aria-label={note?.label}
      >
        <td className="type">
          {toTitleCase(type)}
          {isExplained && (
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
