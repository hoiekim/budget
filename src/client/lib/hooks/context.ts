import { createContext, useContext, Dispatch, SetStateAction } from "react";
import { MaskedUser } from "server";
import { ViewDate } from "common";
import { ClientRouter, Status, Data, Calculations, CapacityData } from "client";

export enum ScreenType {
  Narrow,
  Medium,
  Wide,
}

type CalculateFn = ((data: Data) => void) & {
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
  viewDate: ViewDate;
  setViewDate: Dispatch<SetStateAction<ViewDate>>;
  /** Clear the `view_date` URL param entirely (Current mode) — different
   * from `setViewDate(new ViewDate("month"))` which writes today's
   * period explicitly. Used by the date-picker modal's Current button
   * so a bookmark to `/dashboard` (no param) stays anchored to "now"
   * rather than freezing to the current period at bookmark time. */
  resetViewDate: () => void;
  screenType: ScreenType;
}

export const Context = createContext<ContextType>({} as ContextType);

export const useAppContext = () => useContext(Context);
