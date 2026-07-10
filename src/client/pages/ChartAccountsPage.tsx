import { ChangeEventHandler } from "react";
import { ChartType, MAX_FLOAT, numberToCommaString, UNSORTED_BUDGET_ID } from "common";
import {
  useAppContext,
  useMutate,
  PATH,
  BalanceChartConfiguration,
  Chart,
  ProjectionChartConfiguration,
  FlowChartConfiguration,
} from "client";
import { ToggleInput, Properties, PropertyLabel, Property, Row } from "client/components";

export const ChartAccountsPage = () => {
  const { data, router, viewDate } = useAppContext();
  const chartMutate = useMutate(Chart);
  const { charts } = data;

  const params = router.getActiveParams(PATH.CHART_ACCOUNTS);
  const chart_id = params.get("chart_id") || "";

  const chart = charts.get(chart_id);

  if (!chart) return <></>;

  const { type, configuration } = chart;
  const { account_ids } = configuration;
  const showBudgetSelector = type === ChartType.BALANCE || type === ChartType.FLOW;
  const budget_ids = showBudgetSelector
    ? (configuration as BalanceChartConfiguration | FlowChartConfiguration).budget_ids
    : [];
  const { accounts, budgets } = data;

  const accountRows = accounts
    .filter((a) => !a.hide)
    .map((a) => {
      const onChangeToggle: ChangeEventHandler<HTMLInputElement> = async () => {
        const newAccountIds = account_ids.includes(a.account_id)
          ? account_ids.filter((id) => id !== a.account_id)
          : [...account_ids, a.account_id];
        let updatedConfiguration:
          | BalanceChartConfiguration
          | ProjectionChartConfiguration
          | FlowChartConfiguration;
        const updated = { ...configuration, account_ids: newAccountIds };
        if (type === ChartType.BALANCE) {
          updatedConfiguration = new BalanceChartConfiguration(updated);
        } else if (type === ChartType.PROJECTION) {
          updatedConfiguration = new ProjectionChartConfiguration(updated);
        } else {
          updatedConfiguration = new FlowChartConfiguration(updated);
        }
        await chartMutate.update(new Chart({ ...chart, configuration: updatedConfiguration }));
      };

      return (
        <Row key={a.id} className="keyValue">
          <div>
            <span>{a.custom_name || a.name}</span>
            <span className="small">&nbsp;&nbsp;{a.type}</span>
          </div>
          <ToggleInput
            defaultChecked={account_ids.includes(a.account_id)}
            onChange={onChangeToggle}
          />
        </Row>
      );
    });

  const makeBudgetToggleHandler =
    (budget_id: string): ChangeEventHandler<HTMLInputElement> =>
    async () => {
      const newBudgetIds = budget_ids.includes(budget_id)
        ? budget_ids.filter((id) => id !== budget_id)
        : [...budget_ids, budget_id];
      const updatedFields = { ...configuration, budget_ids: newBudgetIds };
      const updatedConfiguration =
        type === ChartType.BALANCE
          ? new BalanceChartConfiguration(updatedFields)
          : new FlowChartConfiguration(updatedFields);
      await chartMutate.update(new Chart({ ...chart, configuration: updatedConfiguration }));
    };

  // Synthetic "Others" toggle (Flow chart only) for transactions whose
  // effective budget_id is the UNSORTED_BUDGET_ID sentinel — i.e. no
  // label on the transaction and no fallback label on the account.
  // Italic name signals this row is a system-reserved sentinel, not a
  // user-created budget. Without it, a user who whitelists any real
  // budget would silently lose unsorted transactions with no escape
  // hatch other than deselecting every budget (= include all).
  const othersRow =
    type === ChartType.FLOW ? (
      <Row key={UNSORTED_BUDGET_ID} className="keyValue">
        <div>
          <em>Others</em>
          <span className="small">&nbsp;&nbsp;transactions without a budget label</span>
        </div>
        <ToggleInput
          defaultChecked={budget_ids.includes(UNSORTED_BUDGET_ID)}
          onChange={makeBudgetToggleHandler(UNSORTED_BUDGET_ID)}
        />
      </Row>
    ) : null;

  const budgetRows = showBudgetSelector
    ? budgets.toArray().map((b) => {
        const date = viewDate.getEndDate();
        const interval = viewDate.getInterval();
        // Use the derived amount (sums children for synced budgets) for
        // both the display total and the infinite/income classification —
        // stored `month` / `isInfinite` / `isIncome` are stale for synced
        // rows.
        const derivedAmount = b.getActiveAmount(date, interval);
        const isInfinite = Math.abs(derivedAmount) === MAX_FLOAT;
        const isIncome = derivedAmount < 0;
        const capacityAmount = Math.abs(derivedAmount);
        const sign = isIncome ? "+" : "";
        const capacityString = [sign, "$", numberToCommaString(capacityAmount, 0)].join(" ");

        return (
          <Row key={b.id} className="keyValue">
            <div>
              <span>{b.name}</span>
              <span className="small">&nbsp;&nbsp;{isInfinite ? "Unlimited" : capacityString}</span>
            </div>
            <ToggleInput
              defaultChecked={budget_ids.includes(b.id)}
              onChange={makeBudgetToggleHandler(b.id)}
            />
          </Row>
        );
      })
    : [];

  return (
    <div className="ChartAccountsPage">
      <Properties className="sidePadding">
        <PropertyLabel>Select accounts</PropertyLabel>
        <Property>{accountRows}</Property>
        {showBudgetSelector && (
          <>
            <PropertyLabel>Select budgets</PropertyLabel>
            <Property>
              {othersRow}
              {budgetRows}
            </Property>
          </>
        )}
      </Properties>
    </div>
  );
};
