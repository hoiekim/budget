import {
  getBalanceData,
  ScreenType,
  useMemoryState,
  Calculations,
  Data,
  globalData,
  getBudgetData,
  getCapacityData,
} from "client";
import { Dispatch, SetStateAction, useCallback, useEffect, useState } from "react";

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
  const calculate = useCallback(
    (data: Data) => {
      setCalculations((oldCalculations) => {
        const newCalculations = new Calculations(oldCalculations);
        newCalculations.status.isLoading = true;
        return newCalculations;
      });

      setTimeout(() => {
        setCalculations((oldCalculations) => {
          const newCalculations = new Calculations(oldCalculations);
          newCalculations.update({
            balanceData: getBalanceData(data),
            capacityData: getCapacityData(data),
            ...getBudgetData(data),
          });
          newCalculations.status.isInit = true;
          newCalculations.status.isLoading = false;
          return newCalculations;
        });
      }, 10);
    },
    [setCalculations],
  );

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
