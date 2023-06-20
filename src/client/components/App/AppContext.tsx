import { useState, ReactNode } from "react";
import { useLocalStorage, ContextType, Context, useRouter } from "client";
import { MaskedUser } from "server";
import { data as _data, Interval, ViewDate } from "common";
import { useData } from "./lib";

interface Props {
  initialUser: ContextType["user"];
  children?: ReactNode;
}

const AppContext = ({ initialUser, children }: Props) => {
  const [data, setData] = useData();
  const [user, setUser] = useState<MaskedUser | undefined>(initialUser);
  const [selectedInterval, setSelectedInterval] = useLocalStorage<Interval>(
    "selectedInterval",
    "month"
  );

  const [viewDate, setViewDate] = useState(new ViewDate(selectedInterval));
  const router = useRouter();

  const contextValue: ContextType = {
    data,
    setData,
    user,
    setUser,
    router,
    selectedInterval,
    setSelectedInterval,
    viewDate,
    setViewDate,
  };

  return <Context.Provider value={contextValue}>{children}</Context.Provider>;
};

export default AppContext;
