import {
  getBalanceData,
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

type CalculateFn = ((data: Data) => void) & {
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
    (data: Data) => {
      const {
        accounts,
        accountSnapshots,
        holdingSnapshots,
        transactions,
        splitTransactions,
        investmentTransactions,
        budgets,
        sections,
        categories,
      } = data;

      setCalculations((oldCalculations) => {
        const newCalculations = new Calculations(oldCalculations);

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
        );

        const capacityData = getCapacityData(budgets, sections, categories);

        newCalculations.update({ balanceData, transactionFamilies, budgetData, capacityData });

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
