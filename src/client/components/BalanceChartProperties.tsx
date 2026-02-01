import { ChangeEventHandler, MouseEventHandler, ReactNode, useState } from "react";
import { ChartType } from "common";
import {
  BalanceChart,
  Chart,
  ChartDictionary,
  Data,
  call,
  PATH,
  useAppContext,
  useDebounce,
} from "client";

interface BalanceChartPropertiesProps {
  chart: BalanceChart;
  children?: ReactNode;
}

export const BalanceChartProperties = ({ chart, children }: BalanceChartPropertiesProps) => {
  const { router } = useAppContext();
  const { name, chart_id, type, configuration } = chart;
  const { account_ids, budget_ids } = configuration;

  const { data, setData } = useAppContext();
  const { accounts, budgets } = data;

  const [nameInput, setNameInput] = useState(name);
  const [selectedType, setSelectedType] = useState<ChartType>(type);

  const updateDebouncer = useDebounce();

  const updateChart = async (updatedChart: Partial<Chart>) => {
    const r = await call.post("/api/chart", { chart_id, ...updatedChart });
    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newChart = new Chart({ ...chart, ...updatedChart });
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

  const onChangeName: ChangeEventHandler<HTMLInputElement> = (e) => {
    const newName = e.target.value;
    setNameInput(newName);
    updateDebouncer(() => updateChart({ name: newName }).catch(() => setNameInput(name)), 300);
  };

  const onChangeType: ChangeEventHandler<HTMLSelectElement> = (e) => {
    const newType = e.target.value as ChartType;
    setSelectedType(newType);
    updateChart({ type: newType });
  };

  const onClickAccounts: MouseEventHandler<HTMLButtonElement> = () => {
    router.go(PATH.CHART_ACCOUNTS, { params: new URLSearchParams({ chart_id }) });
  };

  const selectedAccountsCount = accounts.filter((a) => {
    return !a.hide && account_ids.includes(a.id);
  }).length;

  const selectedBudgetsCount = budgets.filter((b) => {
    return budget_ids.includes(b.id);
  }).length;

  const onClickRemove: MouseEventHandler<HTMLButtonElement> = async () => {
    if (!window.confirm("Do you want to delete this chart?")) return;
    const r = await call.delete(`/api/chart?id=${chart_id}`);
    if (r.status === "success") {
      setData((oldData) => {
        const newData = new Data(oldData);
        const newCharts = new ChartDictionary(newData.charts);
        newCharts.delete(chart_id);
        newData.charts = newCharts;
        return newData;
      });
      router.back();
    } else {
      console.error(r.message);
      throw new Error(r.message);
    }
  };

  return (
    <div className="Properties">
      <div className="propertyLabel">Chart&nbsp;Profile</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Chart&nbsp;Name</span>
          <input value={nameInput} onChange={onChangeName} />
        </div>
        <div className="row keyValue">
          <span className="propertyName">Chart&nbsp;Type</span>
          <select value={selectedType} onChange={onChangeType}>
            {Object.values(ChartType).map((v) => {
              const chartTypeName =
                v === ChartType.BALANCE
                  ? "Balance Chart"
                  : ChartType.PROJECTION
                    ? "Projection Chart"
                    : "";
              return (
                <option key={`chart_type_option_${v}`} value={v}>
                  {chartTypeName}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      <div className="propertyLabel">Selected&nbsp;Accounts&nbsp;&&nbsp;Budgets</div>
      <div className="property">
        <div className="row button">
          <button onClick={onClickAccounts}>
            {selectedAccountsCount + selectedBudgetsCount}&nbsp;selected
          </button>
        </div>
      </div>

      {children}

      <div className="propertyLabel">&nbsp;</div>
      <div className="property">
        <div className="row button">
          <button className="delete colored" onClick={onClickRemove}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};
