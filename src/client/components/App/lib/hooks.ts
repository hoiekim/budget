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
  capacityData: (updater: (current: CapacityData) => void) => void;
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
   * Partial update: recalculate only capacityData.
   * Accepts a mutator function that modifies the current capacityData in place.
   * Creates a new Calculations object to trigger React re-render.
   */
  const calculateCapacityData = useCallback(
    (updater: (current: CapacityData) => void) => {
      setCalculations((oldCalculations) => {
        const newCapacityData = new CapacityData(oldCalculations.capacityData);
        updater(newCapacityData);
        const newCalculations = new Calculations(oldCalculations);
        newCalculations.update({ capacityData: newCapacityData });
        return newCalculations;
      });
    },
    [setCalculations],
  );

  // Combine into calculate() with calculate.capacityData() pattern
  const calculate: CalculateFn = useMemo(() => {
    const fn = calculateAll as CalculateFn;
    fn.capacityData = calculateCapacityData;
    return fn;
  }, [calculateAll, calculateCapacityData]);

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
