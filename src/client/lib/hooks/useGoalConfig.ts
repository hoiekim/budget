import { useMemo } from "react";
import { inferResidenceState } from "common";
import { inferGoalConfig, InferredGoalConfig, ProjectionChartConfiguration } from "client";
import { useAppContext } from "./context";

/**
 * The goal configuration a projection chart should use: the stored manual
 * values, or — with `auto_goal_config` on — values inferred from the selected
 * budgets, the synced CPI average (`data.inflation`), and the state the past
 * year's transactions point to. See `inferGoalConfig` for the per-field
 * fallbacks.
 */
export const useGoalConfig = (configuration: ProjectionChartConfiguration): InferredGoalConfig => {
  const { data } = useAppContext();
  const { budgets, sections, categories, transactions, inflation } = data;
  const auto = !!configuration.auto_goal_config;

  const state = useMemo(
    () => (auto ? inferResidenceState(transactions.values()) : undefined),
    [auto, transactions],
  );

  const { budget_ids, living_cost, year_over_year_inflation } = configuration;

  return useMemo((): InferredGoalConfig => {
    if (!auto) return { living_cost, year_over_year_inflation };
    return inferGoalConfig({
      configuration: { budget_ids, living_cost, year_over_year_inflation },
      getBudget: (id) => budgets.get(id),
      inflation,
      state,
    });
    // `sections` / `categories` feed synced budgets' amounts through globalData.
  }, [
    auto,
    budget_ids,
    living_cost,
    year_over_year_inflation,
    budgets,
    sections,
    categories,
    inflation,
    state,
  ]);
};
