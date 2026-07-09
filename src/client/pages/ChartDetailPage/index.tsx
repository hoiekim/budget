import { ChartType } from "common";
import { BalanceChart, ProjectionChart, useAppContext, PATH, FlowChart } from "client";
import {
  BalanceChartProperties,
  BalanceChartRow,
  FlowChartProperties,
  FlowChartRow,
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

  const params = router.getActiveParams(PATH.CHART_DETAIL);
  const chart_id = params.get("chart_id") || "";
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

  if (chart.type === ChartType.FLOW) {
    const projectionChart = chart as FlowChart;
    return (
      <div className="ChartDetailPage">
        <FlowChartProperties chart={projectionChart}>
          <FlowChartRow showTitle={false} chart={projectionChart} height={400} />
        </FlowChartProperties>
      </div>
    );
  }

  return <></>;
};
