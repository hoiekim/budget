import { useState, useEffect } from "react";
import { ViewDate } from "client";
import { Interval } from "server";

export interface ViewDateState {
  data: ViewDate;
  next: () => void;
  previous: () => void;
}

export const useViewDate = (selectedInterval: Interval): ViewDateState => {
  const [viewDate, setViewDate] = useState(new ViewDate(selectedInterval));

  useEffect(() => {
    setViewDate((oldViewDate) => {
      const newViewDate = oldViewDate.clone();
      newViewDate.setInterval(selectedInterval);
      return newViewDate;
    });
  }, [selectedInterval, setViewDate]);

  const next = () => {
    const newViewDate = viewDate.clone();
    const result = newViewDate.next();
    setViewDate(newViewDate);
    return result;
  };

  const previous = () => {
    const newViewDate = viewDate.clone();
    const result = newViewDate.previous();
    setViewDate(newViewDate);
    return result;
  };

  const data = viewDate.clone();

  return { data, next, previous };
};
