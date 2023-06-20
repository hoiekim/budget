import { createContext, useContext, Dispatch, SetStateAction } from "react";
import { MaskedUser } from "server";
import { Interval, ViewDate, Data } from "common";
import { ClientRouter } from "client";

export interface ContextType {
  data: Data;
  setData: Dispatch<SetStateAction<Data>>;
  user: MaskedUser | undefined;
  setUser: Dispatch<SetStateAction<MaskedUser | undefined>>;
  router: ClientRouter;
  selectedInterval: Interval;
  setSelectedInterval: Dispatch<SetStateAction<Interval>>;
  viewDate: ViewDate;
  setViewDate: Dispatch<SetStateAction<ViewDate>>;
}

export const Context = createContext<ContextType>({} as ContextType);

export const useAppContext = () => useContext(Context);
