import { useEffect } from "react";
import { ChartType } from "common";
import { NewChartGetResponse } from "server";
import {
  BalanceChart,
  Chart,
  ProjectionChart,
  ScreenType,
  call,
  PATH,
  useAppContext,
  useLocalStorageState,
  useMultiSelectQueryFilter,
  ChartDictionary,
  Data,
  FlowChart,
  indexedDb,
} from "client";
import {
  BalanceChartRow,
  FilterOption,
  FlowChartRow,
  PageFilterTitle,
  ProjectionChartRow,
} from "client/components";
import "./index.css";

const CHART_TYPE_LABELS: Record<ChartType, string> = {
  [ChartType.BALANCE]: "Balance Chart",
  [ChartType.PROJECTION]: "Projection Chart",
  [ChartType.FLOW]: "Flow Chart",
};

const titleForSelection = (types: ChartType[]): string => {
  if (types.length === 0) return "Dashboard";
  if (types.length === 1) return CHART_TYPE_LABELS[types[0]];
  return types.map((t) => CHART_TYPE_LABELS[t]).join(", ");
};

export const DashboardPage = () => {
  const { data, setData, router, screenType } = useAppContext();
  const { charts } = data;
  const { path, params, transition } = router;
  const [chartsOrder, setChartsOrder] = useLocalStorageState<string[]>("chartsOrder", []);

  const activeParams =
    path === PATH.DASHBOARD || screenType !== ScreenType.Narrow
      ? params
      : transition.incomingParams;

  const {
    selected: selectedTypes,
    toggle,
    clearAll,
    options,
  } = useMultiSelectQueryFilter<ChartType>("chart_type", CHART_TYPE_LABELS, {
    activeParams,
  });

  useEffect(() => {
    setChartsOrder((oldOrder) => {
      const set = new Set(oldOrder);
      charts.forEach((_value, key) => set.add(key));
      return Array.from(set.values());
    });
  }, [charts, setChartsOrder]);

  const chartRows = Array.from(charts)
    .filter(([, chart]) => selectedTypes.length === 0 || selectedTypes.includes(chart.type))
    .sort(([a], [b]) => {
      const indexA = chartsOrder.indexOf(a);
      const indexB = chartsOrder.indexOf(b);
      if (indexA === undefined || indexB === undefined) return 0;
      return indexA - indexB;
    })
    .map(([chart_id, chart]) => {
      const onClick = () => {
        const params = new URLSearchParams();
        params.append("chart_id", chart_id);
        router.go(PATH.CHART_DETAIL, { params });
      };
      if (chart.type === ChartType.BALANCE) {
        return (
          <BalanceChartRow
            key={chart_id}
            showTable={false}
            chart={chart as BalanceChart}
            onClick={onClick}
            onSetOrder={setChartsOrder}
          />
        );
      } else if (chart.type === ChartType.PROJECTION) {
        return (
          <ProjectionChartRow
            key={chart_id}
            showTable={false}
            chart={chart as ProjectionChart}
            onClick={onClick}
            onSetOrder={setChartsOrder}
          />
        );
      } else {
        return (
          <FlowChartRow
            key={chart_id}
            showTable={false}
            chart={chart as FlowChart}
            onClick={onClick}
            onSetOrder={setChartsOrder}
          />
        );
      }
    });

  const onClickAddChart = async () => {
    const { body } = await call.get<NewChartGetResponse>("/api/new-chart");
    if (!body) return;

    const { chart_id } = body;

    setData((oldData) => {
      const newData = new Data(oldData);
      const newChart = new Chart({ chart_id });
      indexedDb.save(newChart).catch(console.error);
      const newCharts = new ChartDictionary(newData.charts);
      newCharts.set(chart_id, newChart);
      newData.charts = newCharts;
      return newData;
    });

    router.go(PATH.CHART_DETAIL, { params: new URLSearchParams({ chart_id }) });
  };

  return (
    <div className="DashboardPage">
      <PageFilterTitle
        label={titleForSelection(selectedTypes)}
        dropdownLabel={<>Select&nbsp;chart&nbsp;types</>}
        closeAriaLabel="Close chart type selector"
      >
        <FilterOption checked={selectedTypes.length === 0} onSelect={clearAll}>
          All&nbsp;Charts
        </FilterOption>
        {options.map(({ value, label }) => (
          <FilterOption
            key={value}
            checked={selectedTypes.includes(value)}
            onSelect={() => toggle(value)}
          >
            {label}
          </FilterOption>
        ))}
      </PageFilterTitle>
      {chartRows}
      <button onClick={onClickAddChart}>Add&nbsp;Chart</button>
    </div>
  );
};
