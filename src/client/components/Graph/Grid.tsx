import {
  numberToCommaString,
  currencyCodeToSymbol,
  useAppContext,
  ViewDateStringType,
} from "client";
import { Range } from ".";

interface Props {
  range: Range;
  iso_currency_code: string | null;
}

const Grid = ({ range, iso_currency_code }: Props) => {
  const { x, y } = range;
  const { viewDate } = useAppContext();

  const getTimeMarker = (n: number, type?: ViewDateStringType) => {
    const viewDateClone = viewDate.clone();
    let i = Math.round(n);
    while (i > 0) {
      viewDateClone.previous();
      i--;
    }
    return viewDateClone.toString(type);
  };

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
      <div className="vertical">
        <div />
        <div>{getTimeMarker(x[0] + ((x[1] - x[0]) * 4) / 6, "short")}</div>
        <div>{getTimeMarker(x[0] + ((x[1] - x[0]) * 3) / 6, "short")}</div>
        <div>{getTimeMarker(x[0] + ((x[1] - x[0]) * 2) / 6, "short")}</div>
        <div>{getTimeMarker(x[0] + (x[1] - x[0]) / 6, "short")}</div>
        <div>{getTimeMarker(x[0], "short")}</div>
      </div>
    </div>
  );
};

export default Grid;
