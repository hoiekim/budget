import { ChartType } from "common";

export const getChartTypeName = (type: ChartType) => {
  if (type === ChartType.BALANCE) return "Balance Chart";
  if (type === ChartType.PROJECTION) return "Projection Chart";
  if (type === ChartType.FLOW) return "Flow Chart";
  return "Unknown";
};

export const chartTypeNames = Object.values(ChartType).map(getChartTypeName);
