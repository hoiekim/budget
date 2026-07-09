import { useState, useMemo, ReactNode } from "react";
import { ContextType, Context, useRouter, reduceStatuses, useViewDate } from "client";
import { MaskedUser } from "server";
import { useData, useScreenType } from "./lib";

interface Props {
  initialUser: ContextType["user"];
  children?: ReactNode;
}

const AppContext = ({ initialUser, children }: Props) => {
  const screenType = useScreenType();
  const [data, setData, calculations, calculate] = useData();
  const [user, setUser] = useState<MaskedUser | undefined>(initialUser);

  const router = useRouter(screenType);
  const [viewDate, setViewDate, resetViewDate] = useViewDate(router);

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
      viewDate,
      setViewDate,
      resetViewDate,
      screenType,
    }),
    [
      data,
      setData,
      calculations,
      calculate,
      status,
      user,
      router,
      viewDate,
      resetViewDate,
      screenType,
    ],
  );

  return <Context.Provider value={contextValue}>{children}</Context.Provider>;
};

export default AppContext;
