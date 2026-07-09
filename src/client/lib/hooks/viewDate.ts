import { Dispatch, SetStateAction, useCallback, useState } from "react";
import { getYearMonthString, ViewDate } from "common";
import { ClientRouter } from "./router";

export const useViewDate = (router: ClientRouter) => {
  const { path, params, go } = router;

  const viewDateString = params.get("view_date") || getYearMonthString();
  const interval = viewDateString.length === 4 ? "year" : "month";
  const year = parseInt(viewDateString.substring(0, 4));
  const month = parseInt(viewDateString.substring(4, 6)) || 1;
  const viewDateInit = new Date(year, month - 1);
  const defaultViewDate = new ViewDate(interval, viewDateInit);

  const [viewDate, _setViewDate] = useState(defaultViewDate);

  const setViewDate: Dispatch<SetStateAction<ViewDate>> = useCallback(
    (value) => {
      _setViewDate((prev) => {
        let resolvedValue: ViewDate;
        if (typeof value === "function") resolvedValue = value(prev);
        else resolvedValue = value;

        const newParams = new URLSearchParams(params);
        if (resolvedValue.getInterval() === "year") {
          const year = resolvedValue.getEndDate().getFullYear().toString();
          newParams.set("view_date", year);
        } else {
          const yearMonth = getYearMonthString(resolvedValue.getEndDate());
          newParams.set("view_date", yearMonth);
        }

        go(path, { params: newParams, animate: false });

        return resolvedValue;
      });
    },
    [_setViewDate, path, params, go],
  );

  return [viewDate, setViewDate] as const;
};
