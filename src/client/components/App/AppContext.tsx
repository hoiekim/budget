import { useState, ReactNode, useCallback } from "react";
import {
  useLocalStorageState,
  ContextType,
  Context,
  useRouter,
  Status,
  statusTracker,
  StatusUpdateCommand,
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
  const [data, setData] = useData();
  const [user, setUser] = useState<MaskedUser | undefined>(initialUser);
  const [selectedInterval, setSelectedInterval] = useLocalStorageState<Interval>(
    "selectedInterval",
    "month",
  );

  const [viewDate, setViewDate] = useState(new ViewDate(selectedInterval));
  const router = useRouter();

  const [dataStatus, setDataStatus] = useState<Status>(statusTracker.status);

  const updateStatus = useCallback(
    (command: StatusUpdateCommand) => {
      statusTracker.update(command);
      setDataStatus(statusTracker.status);
    },
    [setDataStatus],
  );

  const contextValue: ContextType = {
    data,
    setData,
    dataStatus,
    updateStatus,
    user,
    setUser,
    router,
    selectedInterval,
    setSelectedInterval,
    viewDate,
    setViewDate,
    screenType,
  };

  return <Context.Provider value={contextValue}>{children}</Context.Provider>;
};

export default AppContext;
