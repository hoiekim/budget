import { createContext, useContext, Dispatch, SetStateAction } from "react";
import { MaskedUser } from "server";
import { Interval, ViewDate, Data } from "common";
import { ClientRouter } from "client";

export enum ScreenType {
  Narrow,
  Medium,
  Wide,
}

export type DataStatus = "loading" | "success" | "error";

export interface ContextType {
  data: Data;
  setData: Dispatch<SetStateAction<Data>>;
  dataStatus: DataStatus;
  setDataStatus: Dispatch<SetStateAction<DataStatus>>;
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
