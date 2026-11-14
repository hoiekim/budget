import { useEffect, useMemo, useState } from "react";
import { inferResidenceState, JSONAverageInflation } from "common";
import type { InflationGetResponse } from "server";
import {
  call,
  inferGoalConfig,
  InferredGoalConfig,
  ProjectionChartConfiguration,
} from "client";
import { useAppContext } from "./context";

/**
 * The server's averaged CPI inflation, fetched once and shared by every
 * projection chart on the page. The figure moves at most monthly, so a page
 * load's worth of caching is plenty.
 *
 * A failed request or a `null` answer (CPI not backfilled yet) is not
 * memoized, so a later mount asks again instead of keeping the fallback for
 * the rest of the session.
 */
let inflationPromise: Promise<JSONAverageInflation | null> | null = null;

export const loadAverageInflation = (): Promise<JSONAverageInflation | null> => {
  if (!inflationPromise) {
    const pending = call.get<InflationGetResponse>("/api/inflation").then((response) => {
      const body = response.status === "success" ? (response.body ?? null) : null;
      if (!body && inflationPromise === pending) inflationPromise = null;
      return body;
    });
    inflationPromise = pending;
  }
  return inflationPromise;
};

/** Drop the memoized inflation figure (tests only). */
export const resetAverageInflationCache = () => {
  inflationPromise = null;
};

/**
 * `undefined` while loading or when `enabled` is false, `null` when the
 * server has no average yet, otherwise the average. Nothing is requested
 * until a caller enables it, so charts in manual mode cost no request.
 */
export const useAverageInflation = (
  enabled: boolean = true,
): JSONAverageInflation | null | undefined => {
  const [inflation, setInflation] = useState<JSONAverageInflation | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadAverageInflation().then((value) => {
      if (alive) setInflation(value);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return enabled ? inflation : undefined;
};

export interface ResolvedGoalConfig extends InferredGoalConfig {
  /** Mirrors `configuration.auto_goal_config`. */
  auto: boolean;
}

/**
 * The goal configuration a projection chart should use: the stored manual
 * values, or — with `auto_goal_config` on — values inferred from the selected
 * budgets, the stored CPI average, and the state the past year's transactions
 * point to. See `inferGoalConfig` for the per-field fallbacks.
 */
export const useGoalConfig = (configuration: ProjectionChartConfiguration): ResolvedGoalConfig => {
  const { data } = useAppContext();
  const { budgets, sections, categories, transactions } = data;
  const auto = !!configuration.auto_goal_config;
  const inflation = useAverageInflation(auto);

  // Scans every transaction, so keep it off the per-render path.
  const state = useMemo(
    () => (auto ? inferResidenceState(transactions.values()) : undefined),
    [auto, transactions],
  );

  const { budget_ids, living_cost, year_over_year_inflation } = configuration;

  return useMemo((): ResolvedGoalConfig => {
    if (!auto) {
      return {
        auto,
        living_cost,
        year_over_year_inflation,
        livingCostSource: "manual",
        inflationSource: "manual",
      };
    }
    return {
      auto,
      ...inferGoalConfig({
        configuration: { budget_ids, living_cost, year_over_year_inflation },
        getBudget: (id) => budgets.get(id),
        inflation,
        state,
      }),
    };
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
