import {
  numberToCommaString,
  currencyCodeToSymbol,
  useAppContext,
  ViewDate,
} from "client";
import { ReactNode } from "react";
import { Range } from ".";

interface Props {
  range: Range;
  iso_currency_code: string | null;
}

const Grid = ({ range, iso_currency_code }: Props) => {
  const { x, y } = range;
  const { viewDate } = useAppContext();

  const moveViewDateBy = (n: number) => {
    const viewDateClone = viewDate.clone();
    let i = Math.round(n);
    while (i > 0) {
      viewDateClone.previous();
      i--;
    }
    return viewDateClone;
  };

  const horizontalLineDivs: ReactNode[] = [];

  const symbol = currencyCodeToSymbol(iso_currency_code || "");
  const M = 4;
  for (let i = 0; i < M; i++) {
    const n = y[0] + ((y[1] - y[0]) * (i + 1)) / M;
    const lineDiv = (
      <div key={i}>
        {symbol}
        {numberToCommaString(n, 0)}
      </div>
    );
    horizontalLineDivs.push(lineDiv);
  }

  const verticalLineDivs: ReactNode[] = [];
  const viewDates: ViewDate[] = [];

  const N = 6;
  for (let i = 0; i < N; i++) {
    const n = x[0] + ((x[1] - x[0]) * i) / N;

    const movedViewDate = moveViewDateBy(n);
    viewDates.push(movedViewDate);
    const currentYear = movedViewDate.getComponents().year;

    const previousMovedViewDate = i ? viewDates[i - 1] : viewDate;
    const previousYear = previousMovedViewDate.getComponents().year;

    type Options = Intl.DateTimeFormatOptions & { week?: "long" | "short" };
    const options: Options = {};
    if (!i || previousYear !== currentYear) options.year = "2-digit";

    switch (viewDate.getInterval()) {
      case "year":
        options.year = "numeric";
        break;
      case "month":
        options.month = "short";
        break;
      case "week":
        options.week = "short";
        break;
      case "day":
        options.month = "2-digit";
        options.day = "2-digit";
        break;
    }

    const lineDiv = <div key={i}>{i !== N - 1 && movedViewDate.toString(options)}</div>;
    verticalLineDivs.push(lineDiv);
  }

  return (
    <div className="Grid">
      <div className="horizontal">{horizontalLineDivs.reverse()}</div>
      <div className="vertical">{verticalLineDivs.reverse()}</div>
    </div>
  );
};

export default Grid;
