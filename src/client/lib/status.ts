import { Status } from "./models";

export const reduceStatuses = (...statuses: Status[]): Status => {
  const isInit = statuses.every(({ isInit }) => isInit);
  const isLoading = statuses.some(({ isLoading }) => isLoading);
  const isError = statuses.some(({ isError }) => isError);
  const isColdSync = statuses.some(({ isColdSync }) => isColdSync);
  return { isInit, isLoading, isError, isColdSync };
};
