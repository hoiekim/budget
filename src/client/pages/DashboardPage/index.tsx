import { useEffect } from "react";
import { ChartType } from "common";
import { NewChartGetResponse } from "server";
import {
  BalanceChart,
  Chart,
  ProjectionChart,
  call,
  PATH,
  useAppContext,
  useLocalStorageState,
  ChartDictionary,
  Data,
} from "client";
import { BalanceChartRow, ProjectionChartRow } from "client/components";
import "./index.css";

export const DashboardPage = () => {
  const { data, setData, router } = useAppContext();
  const { charts } = data;
  const [chartsOrder, setChartsOrder] = useLocalStorageState<string[]>("chartsOrder", []);

  useEffect(() => {
    setChartsOrder((oldOrder) => {
      const set = new Set(oldOrder);
      charts.forEach((_value, key) => set.add(key));
      return Array.from(set.values());
    });
  }, [charts, setChartsOrder]);

  const chartRows = Array.from(charts)
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
      } else {
        return (
          <ProjectionChartRow
            key={chart_id}
            showTable={false}
            chart={chart as ProjectionChart}
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
      const newCharts = new ChartDictionary(newData.charts);
      newCharts.set(chart_id, newChart);
      newData.charts = newCharts;
      return newData;
    });

    router.go(PATH.CHART_DETAIL, { params: new URLSearchParams({ chart_id }) });
  };

  return (
    <div className="DashboardPage">
      <h2>Dashboard</h2>
      {chartRows}
      <button onClick={onClickAddChart}>Add&nbsp;Chart</button>
    </div>
  );
};
