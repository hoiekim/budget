import {
  numberToCommaString,
  currencyCodeToSymbol,
  useAppContext,
  ViewDateStringType,
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

  const verticalLineDivs: ReactNode[] = [];
  const movedViewDates: ViewDate[] = [];

  for (let i = 0; i < 6; i++) {
    const n = x[0] + ((x[1] - x[0]) * i) / 6;
    const movedViewDate = moveViewDateBy(n);
    movedViewDates.push(movedViewDate);
    const movedViewDateYear = movedViewDate.getComponents().year;
    const previousMovedViewDateYear = (
      i ? movedViewDates[i - 1] : viewDate
    ).getComponents().year;

    let type: ViewDateStringType = "short";

    if (previousMovedViewDateYear !== movedViewDateYear) type = "long";

    const line = <div>{moveViewDateBy(n).toString(type)}</div>;
    verticalLineDivs.push(line);
  }

  const symbol = currencyCodeToSymbol(iso_currency_code || "");

  return (
    <div className="Grid">
      <div className="horizontal">
        <div>
          {symbol}
          {numberToCommaString(y[1], 0)}
        </div>
        <div>
          {symbol}
          {numberToCommaString(y[0] + ((y[1] - y[0]) * 3) / 4, 0)}
        </div>
        <div>
          {symbol}
          {numberToCommaString(y[0] + ((y[1] - y[0]) * 2) / 4, 0)}
        </div>
        <div>
          {symbol}
          {numberToCommaString(y[0] + (y[1] - y[0]) / 4, 0)}
        </div>
      </div>
      <div className="vertical">{verticalLineDivs.reverse()}</div>
    </div>
  );
};

export default Grid;
