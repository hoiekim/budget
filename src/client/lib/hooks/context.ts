import { createContext, useContext, Dispatch, SetStateAction } from "react";
import { MaskedUser } from "server";
import { Interval, ViewDate, Data } from "common";
import { ClientRouter, Status, StatusUpdateCommand } from "client";

export enum ScreenType {
  Narrow,
  Medium,
  Wide,
}

export interface ContextType {
  data: Data;
  setData: Dispatch<SetStateAction<Data>>;
  dataStatus: Status;
  updateStatus: (command: StatusUpdateCommand) => void;
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
