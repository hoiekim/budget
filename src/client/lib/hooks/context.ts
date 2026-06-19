import { createContext, useContext, Dispatch, SetStateAction } from "react";
import { MaskedUser } from "server";
import { Interval, ViewDate } from "common";
import { ClientRouter, Status, Data, Calculations, CapacityData, Transfers } from "client";

export enum ScreenType {
  Narrow,
  Medium,
  Wide,
}

export interface CalculateOptions {
  /** Confirmed-transfer transaction ids — threaded into `getBudgetData`
   *  so spent/income aggregation skips internal-movement transactions.
   *  Balance calc intentionally ignores this (per-account historical
   *  balance must still include transfers — Hoie 2026-06-18). */
  confirmedTransferTxIds?: ReadonlySet<string>;
}

type CalculateFn = ((data: Data, opts?: CalculateOptions) => void) & {
  cache: {
    capacityData: (updater: (current: CapacityData) => CapacityData) => void;
  };
};

export interface ContextType {
  data: Data;
  setData: Dispatch<SetStateAction<Data>>;
  calculations: Calculations;
  calculate: CalculateFn;
  status: Status;
  user: MaskedUser | undefined;
  setUser: Dispatch<SetStateAction<MaskedUser | undefined>>;
  router: ClientRouter;
  selectedInterval: Interval;
  setSelectedInterval: Dispatch<SetStateAction<Interval>>;
  viewDate: ViewDate;
  setViewDate: Dispatch<SetStateAction<ViewDate>>;
  screenType: ScreenType;
  transfers: Transfers;
}

export const Context = createContext<ContextType>({} as ContextType);

export const useAppContext = () => useContext(Context);
