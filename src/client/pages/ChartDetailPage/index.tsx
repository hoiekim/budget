import { ChartType } from "common";
import { BalanceChart, ProjectionChart, useAppContext, PATH } from "client";
import {
  BalanceChartProperties,
  BalanceChartRow,
  ProjectionChartProperties,
  ProjectionChartRow,
} from "client/components";
import "./index.css";

export type ChartDetailPageParams = {
  id?: string;
};

export const ChartDetailPage = () => {
  const { data, router } = useAppContext();
  const { charts } = data;
  const { path, params, transition } = router;

  let chart_id: string;
  if (path === PATH.CHART_DETAIL) chart_id = params.get("chart_id") || "";
  else chart_id = transition.incomingParams.get("chart_id") || "";

  const chart = charts.get(chart_id);

  if (!chart) return <></>;

  if (chart.type === ChartType.BALANCE) {
    const balanceChart = chart as BalanceChart;
    return (
      <div className="ChartDetailPage">
        <BalanceChartProperties chart={balanceChart}>
          <BalanceChartRow showTitle={false} chart={balanceChart} />
        </BalanceChartProperties>
      </div>
    );
  }

  if (chart.type === ChartType.PROJECTION) {
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
