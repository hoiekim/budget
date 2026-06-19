import {
  getBalanceData,
  getHoldingsValueData,
  ScreenType,
  useMemoryState,
  Calculations,
  Data,
  globalData,
  getBudgetData,
  getCapacityData,
  CapacityData,
} from "client";
import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useState } from "react";

export interface CalculateOptions {
  /** Membership-test for confirmed-transfer transaction ids — threaded
   *  into `getBudgetData` so spent/income aggregation skips
   *  internal-movement transactions. Typed structurally on `has` so
   *  the standard call site can pass
   *  `transfers.confirmedTransferByTransactionId` (a Map) directly
   *  without materializing a parallel Set. Not threaded into balance
   *  calcs (per Hoie 2026-06-18: per-account historical balance MUST
   *  still include transfer effects). Omitted = pre-PR behavior. */
  confirmedTransferIds?: { has(transaction_id: string): boolean };
}

type CalculateFn = ((data: Data, opts?: CalculateOptions) => void) & {
  cache: {
    capacityData: (updater: (current: CapacityData) => CapacityData) => void;
  };
};

export const useData = () => {
  const [data, _setData] = useMemoryState<Data>("data", globalData);
  const setData: Dispatch<SetStateAction<Data>> = useCallback(
    (nextData) => {
      _setData((oldData) => {
        const newData = nextData instanceof Function ? nextData(oldData) : nextData;
        globalData.update(newData);
        return newData;
      });
    },
    [_setData],
  );

  const [calculations, setCalculations] = useState(new Calculations());

  const calculateAll = useCallback(
    (data: Data, opts?: CalculateOptions) => {
      const {
        accounts,
        accountSnapshots,
        holdingSnapshots,
        securitySnapshots,
        securities,
        transactions,
        splitTransactions,
        investmentTransactions,
        budgets,
        sections,
        categories,
      } = data;

      const confirmedTransferIds = opts?.confirmedTransferIds;

      setCalculations((oldCalculations) => {
        const newCalculations = new Calculations(oldCalculations);

        // Balance data intentionally does NOT receive confirmedTransferIds:
        // per-account historical balance is supposed to reflect the actual
        // value held in each account at each point in time. A transfer
        // moves real dollars between accounts, so dropping it would
        // de-sync the chart from the snapshot baseline (Hoie 2026-06-18).
        const balanceData = getBalanceData(
          accounts,
          accountSnapshots,
          holdingSnapshots,
          transactions,
          investmentTransactions,
        );

        const { transactionFamilies, budgetData } = getBudgetData(
          transactions,
          splitTransactions,
          accounts,
          budgets,
          sections,
          categories,
          confirmedTransferIds,
        );

        const capacityData = getCapacityData(budgets, sections, categories);

        const holdingsValueData = getHoldingsValueData({
          holdingSnapshots,
          securitySnapshots,
          securities,
          investmentTransactions,
        });

        newCalculations.update({
          balanceData,
          transactionFamilies,
          budgetData,
          capacityData,
          holdingsValueData,
        });

        newCalculations.status.isInit = true;
        newCalculations.status.isLoading = false;

        return newCalculations;
      });
    },
    [setCalculations],
  );

  /**
   * Cache update: replace capacityData with a new value returned by the updater.
   * Unlike calculate(), this does not run the full calculation process —
   * it directly updates the cached capacityData in the Calculations object.
   */
  const cacheCapacityData = useCallback(
    (updater: (current: CapacityData) => CapacityData) => {
      setCalculations((oldCalculations) => {
        const newCapacityData = updater(oldCalculations.capacityData);
        const newCalculations = new Calculations(oldCalculations);
        newCalculations.update({ capacityData: newCapacityData });
        return newCalculations;
      });
    },
    [setCalculations],
  );

  // Combine into calculate() with calculate.cache.* pattern for direct cache updates
  const calculate: CalculateFn = useMemo(() => {
    const fn = calculateAll as CalculateFn;
    fn.cache = { capacityData: cacheCapacityData };
    return fn;
  }, [calculateAll, cacheCapacityData]);

  return [data, setData, calculations, calculate] as const;
};

export const useScreenType = () => {
  const [screenWidth, setScreenWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 0,
  );

  useEffect(() => {
    const handleResize = () => setScreenWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const screenType =
    screenWidth < 768
      ? ScreenType.Narrow
      : screenWidth >= 950
        ? ScreenType.Wide
        : ScreenType.Medium;

  return screenType;
};
