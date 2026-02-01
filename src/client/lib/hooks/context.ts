import { createContext, useContext, Dispatch, SetStateAction } from "react";
import { MaskedUser } from "server";
import { Interval, ViewDate } from "common";
import { ClientRouter, Status, Data, Calculations } from "client";

export enum ScreenType {
  Narrow,
  Medium,
  Wide,
}

export interface ContextType {
  data: Data;
  setData: Dispatch<SetStateAction<Data>>;
  calculations: Calculations;
  calculate: (data: Data) => void;
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
