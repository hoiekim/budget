import { numberToCommaString, currencyCodeToSymbol, useAppContext } from "client/lib";
import { Range } from ".";

interface Props {
  range: Range;
  iso_currency_code: string | null;
}

const Grid = ({ range, iso_currency_code }: Props) => {
  const { x, y } = range;
  const { selectedInterval } = useAppContext();
  const symbol = currencyCodeToSymbol(iso_currency_code || "");
  return (
    <div className="Grid">
      <div className="horizontal">
        <div>
          {symbol}
          {numberToCommaString(y[1])}
        </div>
        <div>
          {symbol}
          {numberToCommaString(y[0] + ((y[1] - y[0]) * 3) / 4)}
        </div>
        <div>
          {symbol}
          {numberToCommaString(y[0] + ((y[1] - y[0]) * 2) / 4)}
        </div>
        <div>
          {symbol}
          {numberToCommaString(y[0] + (y[1] - y[0]) / 4)}
        </div>
      </div>
      <div className="vertical">
        <div>{x[0] + ((x[1] - x[0]) * 3) / 4}</div>
        <div>{x[0] + ((x[1] - x[0]) * 2) / 4}</div>
        <div>{x[0] + (x[1] - x[0]) / 4}</div>
        <div>
          ({selectedInterval}) {x[0]}
        </div>
      </div>
    </div>
  );
};

export default Grid;
