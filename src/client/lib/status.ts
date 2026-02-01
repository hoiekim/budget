import { Status } from "./models";

export const reduceStatuses = (...statuses: Status[]): Status => {
  const isInit = statuses.every(({ isInit }) => isInit);
  const isLoading = statuses.some(({ isLoading }) => isLoading);
  const isError = statuses.some(({ isError }) => isError);
  return { isInit, isLoading, isError };
};
