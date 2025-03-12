import { useAppContext, PATH, call, useDebounce } from "client";
import { BalanceChartRow, CapacityInput, ProjectionChartRow } from "client/components";
import "./index.css";
import {
  BalanceChart,
  Chart,
  CHART_TYPE,
  ChartDictionary,
  Data,
  getDateString,
  ProjectionChart,
} from "common";
import {
  ChangeEventHandler,
  FocusEventHandler,
  MouseEventHandler,
  ReactNode,
  useState,
} from "react";

export type ChartDetailPageParams = {
  id?: string;
};

export const ChartDetailPage = () => {
  const { data, router } = useAppContext();
  const { charts } = data;
  const { path, params, transition } = router;

  let chart_id: string;
  if (path === PATH.CHART_DETAIL) chart_id = params.get("id") || "";
  else chart_id = transition.incomingParams.get("id") || "";

  const chart = charts.get(chart_id);

  if (!chart) return <></>;

  if (chart.type === CHART_TYPE.BALANCE) {
    const balanceChart = chart as BalanceChart;
    return (
      <div className="ChartDetailPage">
        <BalanceChartProperties chart={balanceChart}>
          <BalanceChartRow showTitle={false} chart={balanceChart} />
        </BalanceChartProperties>
      </div>
    );
  }

  if (chart.type === CHART_TYPE.PROJECTION) {
    const projectionChart = chart as ProjectionChart;
    return (
      <div className="ChartDetailPage">
        <ProjectionChartProperties chart={projectionChart}>
          <ProjectionChartRow showTitle={false} chart={projectionChart} />
        </ProjectionChartProperties>
      </div>
    );
  }

  return <></>;
};

interface BalanceChartPropertiesProps {
  chart: BalanceChart;
  children?: ReactNode;
}

const BalanceChartProperties = ({ chart, children }: BalanceChartPropertiesProps) => {
  const { router } = useAppContext();
  const { name, chart_id, type, configuration } = chart;
  const { account_ids, budget_ids } = configuration;

  const { data, setData } = useAppContext();
  const { accounts, budgets } = data;

  const [nameInput, setNameInput] = useState(name);
  const [selectedType, setSelectedType] = useState<CHART_TYPE>(type);

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
    const newType = e.target.value as CHART_TYPE;
    setSelectedType(newType);
    updateChart({ type: newType });
  };

  const onClickAccounts: MouseEventHandler<HTMLButtonElement> = () => {
    router.go(PATH.CHART_ACCOUNTS, { params: new URLSearchParams({ id: chart_id }) });
  };

  const selectedAccountsCount = accounts.filter((a) => {
    return !a.hide && account_ids.includes(a.id);
  }).length;

  const selectedBudgetsCount = budgets.filter((b) => {
    return budget_ids.includes(b.id);
  }).length;

  const onClickRemove: MouseEventHandler<HTMLButtonElement> = async () => {
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
            {Object.values(CHART_TYPE).map((v) => {
              const chartTypeName =
                v === CHART_TYPE.BALANCE
                  ? "Balance Chart"
                  : CHART_TYPE.PROJECTION
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

interface ProjectionChartPropertiesProps {
  chart: ProjectionChart;
  children?: ReactNode;
}

const ProjectionChartProperties = ({ chart, children }: ProjectionChartPropertiesProps) => {
  const { router } = useAppContext();
  const { chart_id, name, type, configuration } = chart;

  const {
    account_ids,
    initial_saving,
    contribution,
    living_cost,
    anual_percentage_yield,
    year_over_year_inflation,
  } = configuration;

  const { data, setData } = useAppContext();
  const { accounts } = data;

  const [selectedType, setSelectedType] = useState<CHART_TYPE>(type);
  const [nameInput, setNameInput] = useState(name);

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
    const newType = e.target.value as CHART_TYPE;
    setSelectedType(newType);
    updateChart({ type: newType });
  };

  const onClickAccounts: MouseEventHandler<HTMLButtonElement> = (e) => {
    router.go(PATH.CHART_ACCOUNTS, { params: new URLSearchParams({ id: chart_id }) });
  };

  const onBlurInitialSavingAmount: FocusEventHandler<HTMLInputElement> = (e) => {
    const newAmount = +e.target.value;
    const newConfiguration = {
      ...configuration,
      initial_saving: { ...initial_saving, amount: newAmount },
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurInitialSavingDate: FocusEventHandler<HTMLInputElement> = (e) => {
    const newDate = new Date(e.target.value);
    const newConfiguration = {
      ...configuration,
      initial_saving: { ...initial_saving, amountAsOf: newDate },
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurContribution: FocusEventHandler<HTMLInputElement> = (e) => {
    const newAmount = +e.target.value;
    const newConfiguration = { ...configuration, contribution: newAmount };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurApy: FocusEventHandler<HTMLInputElement> = (e) => {
    const newRate = +e.target.value / 100 + 1;
    const newConfiguration = {
      ...configuration,
      anual_percentage_yield: newRate,
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurLivingCostAmount: FocusEventHandler<HTMLInputElement> = (e) => {
    const newAmount = +e.target.value;
    const newConfiguration = {
      ...configuration,
      living_cost: { ...living_cost, amount: newAmount },
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurLivingCostDate: FocusEventHandler<HTMLInputElement> = (e) => {
    const newDate = new Date(e.target.value);
    const newConfiguration = {
      ...configuration,
      living_cost: { ...living_cost, amountAsOf: newDate },
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurTaxRate: FocusEventHandler<HTMLInputElement> = (e) => {
    const newRate = +e.target.value / 100;
    const newConfiguration = {
      ...configuration,
      living_cost: { ...living_cost, taxRate: newRate },
    };
    updateChart({ configuration: newConfiguration });
  };

  const onBlurYoyInflation: FocusEventHandler<HTMLInputElement> = (e) => {
    const newRate = +e.target.value / 100 + 1;
    const newConfiguration = {
      ...configuration,
      year_over_year_inflation: newRate,
    };
    updateChart({ configuration: newConfiguration });
  };

  const numberOfSelectedAccounts = accounts.filter((a) => {
    return !a.hide && account_ids.includes(a.account_id);
  }).length;

  const onClickRemove: MouseEventHandler<HTMLButtonElement> = async () => {
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
            {Object.values(CHART_TYPE).map((v) => {
              const chartTypeName =
                v === CHART_TYPE.BALANCE
                  ? "Balance Chart"
                  : CHART_TYPE.PROJECTION
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

      <div className="propertyLabel">Selected&nbsp;Accounts</div>
      <div className="property">
        <div className="row button">
          <button onClick={onClickAccounts}>{numberOfSelectedAccounts}&nbsp;selected</button>
        </div>
      </div>

      {children}

      <div className="propertyLabel">Saving&nbsp;Configuration</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Initial&nbsp;Saving</span>
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={initial_saving.amount}
              onBlur={onBlurInitialSavingAmount}
            />
            <span className="small">&nbsp;$</span>
          </div>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Initial&nbsp;Saving&nbsp;as&nbsp;of</span>
          <input
            type="date"
            defaultValue={getDateString(initial_saving.amountAsOf)}
            onBlur={onBlurInitialSavingDate}
          />
        </div>
        <div className="row keyValue">
          <span className="propertyName">Monthly&nbsp;Contribution</span>
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={contribution}
              onBlur={onBlurContribution}
            />
            <span className="small">&nbsp;$</span>
          </div>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Anual&nbsp;Percentage&nbsp;Yield</span>
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={(anual_percentage_yield - 1) * 100}
              maxValue={1000}
              minValue={0}
              fixed={2}
              onBlur={onBlurApy}
            />
            <span className="small">&nbsp;%</span>
          </div>
        </div>
      </div>
      <div className="propertyLabel">Goal&nbsp;Configuration</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Living&nbsp;Cost</span>
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={living_cost.amount}
              onBlur={onBlurLivingCostAmount}
            />
            <span className="small">&nbsp;$</span>
          </div>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Living&nbsp;Cost&nbsp;as&nbsp;of</span>
          <input
            type="date"
            defaultValue={getDateString(living_cost.amountAsOf)}
            onBlur={onBlurLivingCostDate}
          />
        </div>
        <div className="row keyValue">
          <span className="propertyName">Tax&nbsp;Rate</span>
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={(living_cost.taxRate || 0) * 100}
              maxValue={100}
              minValue={0}
              fixed={2}
              onBlur={onBlurTaxRate}
            />
            <span className="small">&nbsp;%</span>
          </div>
        </div>
        <div className="row keyValue">
          <span className="propertyName">YoY&nbsp;Inflation</span>
          <div>
            <CapacityInput
              style={{ width: 100 }}
              defaultValue={(year_over_year_inflation - 1) * 100}
              maxValue={1000}
              minValue={0}
              fixed={2}
              onBlur={onBlurYoyInflation}
            />
            <span className="small">&nbsp;%</span>
          </div>
        </div>
      </div>

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
