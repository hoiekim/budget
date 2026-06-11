import { useState, useMemo, ReactNode } from "react";
import {
  useLocalStorageState,
  ContextType,
  Context,
  useRouter,
  reduceStatuses,
  useTransfers,
} from "client";
import { MaskedUser } from "server";
import { Interval, ViewDate } from "common";
import { useData, useScreenType } from "./lib";

interface Props {
  initialUser: ContextType["user"];
  children?: ReactNode;
}

const AppContext = ({ initialUser, children }: Props) => {
  const screenType = useScreenType();
  const [data, setData, calculations, calculate] = useData();
  const [user, setUser] = useState<MaskedUser | undefined>(initialUser);
  const [selectedInterval, setSelectedInterval] = useLocalStorageState<Interval>(
    "selectedInterval",
    "month",
  );

  const [viewDate, setViewDate] = useState(new ViewDate(selectedInterval));
  const router = useRouter();
  const transfers = useTransfers(user);

  const status = reduceStatuses(data?.status, calculations?.status);

  const contextValue: ContextType = useMemo(
    () => ({
      data,
      setData,
      calculations,
      calculate,
      status,
      user,
      setUser,
      router,
      selectedInterval,
      setSelectedInterval,
      viewDate,
      setViewDate,
      screenType,
      transfers,
    }),
    [data, setData, calculations, calculate, status, user, router, selectedInterval, setSelectedInterval, viewDate, screenType, transfers],
  );

  return <Context.Provider value={contextValue}>{children}</Context.Provider>;
};

export default AppContext;
