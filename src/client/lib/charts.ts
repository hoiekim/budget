import { AmountInTime, BalanceData, ProjectionChartConfiguration } from "client";
import type { BudgetFamily } from "client/lib/models/BudgetFamily";
import {
  ChartType,
  estimateIncomeTax,
  JSONAverageInflation,
  MAX_FLOAT,
  Optional,
  ViewDate,
} from "common";

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
    startValue += balanceArray[maxLength - 1] || 0;
    endValue += balanceArray[0] || 0;
  });

  const n = maxLength - 1;

  const startValueAsOf = viewDate.clone().previous(Math.max(0, n)).getEndDate();

  const config: Optional<ProjectionChartConfiguration, "living_cost" | "year_over_year_inflation"> =
    new ProjectionChartConfiguration({
      account_ids: accountIds,
      auto_saving_config: true,
      initial_saving: new AmountInTime({ amount: startValue, amountAsOf: startValueAsOf }),
    });

  // Leave out so we don't accidentally carry the default value to the downstreams
  delete config.living_cost;
  delete config.year_over_year_inflation;

  if (n > 0) {
    const { anual_percentage_yield } = config;
    const mpy = Math.pow(anual_percentage_yield, 1 / 12);
    const mpyn = Math.pow(mpy, n);

    // enjoy the math
    config.contribution = ((endValue - startValue * mpyn) * (mpy - 1)) / (mpyn - 1);
  }

  return config;
};

/**
 * The latest `active_from` behind an entity's amount at `date`: its own active
 * capacity's start and, when that capacity is synced (its amount is the sum of
 * its children), every descendant's too — a synced budget's amount last
 * changed whenever any child's did. `undefined` when every capacity involved
 * is a default one with no start date.
 */
export const getLatestActiveFrom = (entity: BudgetFamily, date: Date): Date | undefined => {
  const capacity = entity.getActiveCapacity(date);
  let latest = capacity.active_from;
  if (capacity.is_synced) {
    for (const child of entity.getChildren()) {
      const childLatest = getLatestActiveFrom(child, date);
      if (childLatest && (!latest || childLatest > latest)) latest = childLatest;
    }
  }
  return latest;
};

/**
 * Living cost from the selected budgets: the sum of their monthly amounts at
 * `today`, as of the latest start date among the budget periods (capacities)
 * those amounts come from — the amounts are in that date's dollars. With no
 * dated period at all, the start of the current month stands in.
 *
 * Only spending counts: income budgets (negative amounts) and unlimited ones
 * are skipped. `undefined` when nothing selected contributes, so the caller
 * can fall back to the manual value.
 */
export const inferLivingCost = (
  budgets: BudgetFamily[],
  today: Date = new Date(),
): AmountInTime | undefined => {
  let amount = 0;
  let contributing = 0;
  let latest: Date | undefined;

  for (const budget of budgets) {
    const monthly = budget.getActiveAmount(today, "month");
    if (!Number.isFinite(monthly) || monthly <= 0 || Math.abs(monthly) === MAX_FLOAT) continue;
    amount += monthly;
    contributing++;
    const activeFrom = getLatestActiveFrom(budget, today);
    if (activeFrom && (!latest || activeFrom > latest)) latest = activeFrom;
  }

  if (!contributing) return undefined;
  const amountAsOf = latest ?? new ViewDate("month", today).getStartDate();
  return new AmountInTime({ amount, amountAsOf });
};

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Effective tax rate on a living cost, treating the annual living cost as the
 * income it would take to fund. The amount is first carried from its as-of
 * date to `today` at `yearOverYearInflation`, because the tax tables are in
 * current dollars and the brackets are inflation-indexed — an old budget
 * amount would otherwise land in too low a bracket.
 */
export const inferTaxRate = (
  livingCost: Pick<AmountInTime, "amount" | "amountAsOf">,
  state: string | undefined,
  yearOverYearInflation: number,
  today: Date = new Date(),
): number => {
  const years = Math.max(0, (today.getTime() - livingCost.amountAsOf.getTime()) / MS_PER_YEAR);
  const growth = Math.pow(yearOverYearInflation > 0 ? yearOverYearInflation : 1, years);
  const annualIncome = livingCost.amount * 12 * growth;
  return estimateIncomeTax(annualIncome, state).effectiveRate;
};

export interface InferredGoalConfig
  extends Pick<ProjectionChartConfiguration, "living_cost" | "year_over_year_inflation"> {
  /** USPS code of the state the tax estimate used; `undefined` means federal only. */
  state?: string;
}

export interface InferGoalConfigInput {
  configuration: Pick<
    ProjectionChartConfiguration,
    "budget_ids" | "living_cost" | "year_over_year_inflation"
  >;
  /** Looks up a budget by id — `data.budgets` in the app. */
  getBudget: (budget_id: string) => BudgetFamily | undefined;
  inflation: JSONAverageInflation | null | undefined;
  state: string | undefined;
  today?: Date;
}

/**
 * Goal configuration for a projection chart in auto mode. Each field falls
 * back to the stored manual value on its own when its source has nothing yet
 * (no budgets selected, CPI not backfilled), so turning auto on never blanks
 * the chart. The tax rate is always estimated — federal tax needs no input,
 * and an unknown state only drops the state share.
 */
export const inferGoalConfig = ({
  configuration,
  getBudget,
  inflation,
  state,
  today = new Date(),
}: InferGoalConfigInput): InferredGoalConfig => {
  const selected = (configuration.budget_ids ?? [])
    .map((id) => getBudget(id))
    .filter((b): b is BudgetFamily => !!b);

  const inferredLivingCost = inferLivingCost(selected, today);
  const year_over_year_inflation =
    inflation?.year_over_year_inflation ?? configuration.year_over_year_inflation;

  const base = inferredLivingCost ?? configuration.living_cost;
  const taxRate = inferTaxRate(base, state, year_over_year_inflation, today);
  const living_cost = new AmountInTime({
    amount: base.amount,
    amountAsOf: base.amountAsOf,
    taxRate,
  });

  return { living_cost, year_over_year_inflation, state };
};
