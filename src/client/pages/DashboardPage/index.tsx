import { BalanceChartRow, ProjectionChartRow } from "client/components";
import "./index.css";
import { call, PATH, useAppContext } from "client";
import { BalanceChart, Chart, CHART_TYPE, ChartDictionary, Data, ProjectionChart } from "common";
import { NewChartGetResponse } from "server";

export const DashboardPage = () => {
  const { data, setData, router } = useAppContext();
  const { charts } = data;

  const balanceCharts = charts.filter((c) => c.type === CHART_TYPE.BALANCE);
  const projectionCharts = charts.filter((c) => c.type === CHART_TYPE.PROJECTION);
  const balanceChartRows = balanceCharts.map((chart) => {
    const onClick = () => {
      const params = new URLSearchParams();
      params.append("id", chart.id);
      router.go(PATH.CHART_DETAIL, { params });
    };
    return <BalanceChartRow key={chart.id} chart={chart as BalanceChart} onClick={onClick} />;
  });
  const projectionChartRows = projectionCharts.map((chart) => {
    const onClick = () => {
      const params = new URLSearchParams();
      params.append("id", chart.id);
      router.go(PATH.CHART_DETAIL, { params });
    };
    return <ProjectionChartRow key={chart.id} chart={chart as ProjectionChart} onClick={onClick} />;
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

    router.go(PATH.CHART_DETAIL, { params: new URLSearchParams({ id: chart_id }) });
  };

  return (
    <div className="DashboardPage">
      <h2>Dashboard</h2>
      {balanceChartRows}
      {projectionChartRows}
      <button onClick={onClickAddChart}>Add&nbsp;Chart</button>
    </div>
  );
};
