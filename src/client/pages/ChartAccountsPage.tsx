import { ChangeEventHandler } from "react";
import { useAppContext, call, PATH } from "client";
import { ToggleInput } from "client/components";
import {
  BalanceChartConfiguration,
  Chart,
  CHART_TYPE,
  ChartDictionary,
  Data,
  numberToCommaString,
  ProjectionChartConfiguration,
} from "common";

export const ChartAccountsPage = () => {
  const { data, setData, router, viewDate } = useAppContext();
  const { charts } = data;
  const { path, params, transition } = router;

  let chart_id: string;
  if (path === PATH.CHART_ACCOUNTS) chart_id = params.get("chart_id") || "";
  else chart_id = transition.incomingParams.get("chart_id") || "";

  const chart = charts.get(chart_id);

  if (!chart) return <></>;

  const { type, configuration } = chart;
  const { account_ids } = configuration;
  const { accounts, budgets } = data;

  const Configuration =
    type === CHART_TYPE.BALANCE ? BalanceChartConfiguration : ProjectionChartConfiguration;

  const accountRows = accounts
    .filter((a) => !a.hide)
    .map((a) => {
      const onChangeToggle: ChangeEventHandler<HTMLInputElement> = async () => {
        const newAccountIds = account_ids.includes(a.account_id)
          ? account_ids.filter((id) => id !== a.account_id)
          : [...account_ids, a.account_id];
        const updatedConfiguration = new Configuration({
          ...configuration,
          account_ids: newAccountIds,
        });
        const r = await call.post("/api/chart", { chart_id, configuration: updatedConfiguration });
        if (r.status === "success") {
          setData((oldData) => {
            const newData = new Data(oldData);
            const newChart = new Chart({ ...chart, configuration: updatedConfiguration });
            const newCharts = new ChartDictionary(newData.charts);
            newCharts.set(chart_id, newChart);
            newData.charts = newCharts;
            return newData;
          });
        } else {
          console.error(r.message);
          throw new Error(r.message);
        }
      };

      return (
        <div key={a.id} className="row keyValue">
          <div>
            <span>{a.custom_name || a.name}</span>
            <span className="small">&nbsp;&nbsp;{a.type}</span>
          </div>
          <ToggleInput
            defaultChecked={account_ids.includes(a.account_id)}
            onChange={onChangeToggle}
          />
        </div>
      );
    });

  if (type !== CHART_TYPE.BALANCE) {
    return (
      <div className="ChartAccountsPage">
        <div className="Properties sidePadding">
          <div className="propertyLabel">Select accounts</div>
          <div className="property">{accountRows}</div>
        </div>
      </div>
    );
  }

  const { budget_ids } = chart.configuration as BalanceChartConfiguration;

  const budgetRows = budgets.toArray().map((b) => {
    const onChangeToggle: ChangeEventHandler<HTMLInputElement> = async () => {
      const newBudgetIds = budget_ids.includes(b.id)
        ? budget_ids.filter((id) => id !== b.id)
        : [...budget_ids, b.id];
      const updatedConfiguration = new Configuration({
        ...configuration,
        budget_ids: newBudgetIds,
      });
      const r = await call.post("/api/chart", { chart_id, configuration: updatedConfiguration });
      if (r.status === "success") {
        setData((oldData) => {
          const newData = new Data(oldData);
          const newChart = new Chart({ ...chart, configuration: updatedConfiguration });
          const newCharts = new ChartDictionary(newData.charts);
          newCharts.set(chart_id, newChart);
          newData.charts = newCharts;
          return newData;
        });
      } else {
        console.error(r.message);
        throw new Error(r.message);
      }
    };

    const capacity = b.getActiveCapacity(viewDate.getEndDate());
    const interval = viewDate.getInterval();
    const { isInfinite, isIncome } = capacity;

    const capacityAmount = Math.abs(capacity[interval]);
    const sign = isIncome ? "+" : "";
    const capacityString = [sign, "$", numberToCommaString(capacityAmount, 0)].join(" ");

    return (
      <div key={b.id} className="row keyValue">
        <div>
          <span>{b.name}</span>
          <span className="small">&nbsp;&nbsp;{isInfinite ? "Unlimited" : capacityString}</span>
        </div>
        <ToggleInput defaultChecked={budget_ids.includes(b.id)} onChange={onChangeToggle} />
      </div>
    );
  });

  return (
    <div className="ChartAccountsPage">
      <div className="Properties sidePadding">
        <div className="propertyLabel">Select accounts</div>
        <div className="property">{accountRows}</div>
        {type === CHART_TYPE.BALANCE && (
          <>
            <div className="propertyLabel">Select budgets</div>
            <div className="property">{budgetRows}</div>
          </>
        )}
      </div>
    </div>
  );
};
