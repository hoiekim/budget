import { createContext, useContext, Dispatch, SetStateAction } from "react";
import { MaskedUser } from "server";
import { Interval, ViewDate } from "common";
import { ClientRouter, Status, Data, Calculations, CapacityData } from "client";

export enum ScreenType {
  Narrow,
  Medium,
  Wide,
}

type CalculateFn = ((data: Data) => void) & {
  capacityData: (updater: (current: CapacityData) => void) => void;
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
}

export const Context = createContext<ContextType>({} as ContextType);

export const useAppContext = () => useContext(Context);
