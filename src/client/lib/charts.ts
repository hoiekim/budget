import { AmountInTime, BalanceData, ProjectionChartConfiguration } from "client";
import { ChartType, Optional, ViewDate } from "common";

export const getChartTypeName = (type: ChartType) => {
  if (type === ChartType.BALANCE) return "Balance Chart";
  if (type === ChartType.PROJECTION) return "Projection Chart";
  if (type === ChartType.FLOW) return "Flow Chart";
  return "Unknown";
};

export const chartTypeNames = Object.values(ChartType).map(getChartTypeName);

export const inferSavingConfig = (
  balanceData: BalanceData,
  accountIds: string[],
  viewDate: ViewDate,
): Omit<ProjectionChartConfiguration, "living_cost" | "year_over_year_inflation"> => {
  let maxLength = 0;
  let startValue = 0;
  let endValue = 0;

  accountIds.forEach((accountId) => {
    const balanceArray = balanceData.get(accountId).toArray(viewDate);
    if (maxLength < balanceArray.length) {
      startValue = 0;
      maxLength = balanceArray.length;
    }
    startValue += balanceArray[maxLength] || 0;
    endValue += balanceArray[0] || 0;
  });

  const n = maxLength - 1;

  const startValueAsOf = viewDate.clone().previous(n).getEndDate();

  const config: Optional<ProjectionChartConfiguration, "living_cost" | "year_over_year_inflation"> =
    new ProjectionChartConfiguration({
      account_ids: accountIds,
      auto_saving_config: true,
      initial_saving: new AmountInTime({ amount: startValue, amountAsOf: startValueAsOf }),
    });

  // Leave out so we don't accidentally carry the default value to the downstreams
  delete config.living_cost;
  delete config.year_over_year_inflation;

  const { anual_percentage_yield } = config;
  const mpy = Math.pow(anual_percentage_yield, 1 / 12);
  const mpyn = Math.pow(mpy, n);

  // enjoy the math
  config.contribution = ((endValue - startValue * mpyn) * (mpy - 1)) / (mpyn - 1);

  return config;
};
