import { Account, currencyCodeToSymbol, numberToCommaString } from "common";

interface Props {
  balances: Account["balances"];
  type: Account["type"];
}

export const Balance = ({ balances, type }: Props) => {
  const { available, current, iso_currency_code, unofficial_currency_code } = balances;

  const symbol = currencyCodeToSymbol(iso_currency_code || unofficial_currency_code || "USD");
  const formattedAvailable = numberToCommaString(available as number);
  const formattedCurrent = numberToCommaString(current as number);

  if (type === "credit") {
    return (
      <div className="Balance">
        <div>
          <span>
            {symbol}
            {formattedCurrent}
          </span>
          <span>owed</span>
        </div>
        <div>
          <span>
            {symbol}
            {formattedAvailable}
          </span>
          <span>available</span>
        </div>
      </div>
    );
  } else if (type === "investment") {
    return (
      <div className="Balance">
        <div>
          <span>
            {symbol}
            {formattedCurrent}
          </span>
          <span>invested</span>
        </div>
        <div>
          <span>
            {symbol}
            {formattedAvailable}
          </span>
          <span>in cash</span>
        </div>
      </div>
    );
  } else if (available && current) {
    if (available === current) {
      return (
        <div className="Balance">
          <div>
            <span>
              {symbol}
              {formattedCurrent}
            </span>
            <span>available</span>
          </div>
        </div>
      );
    } else {
      return (
        <div className="Balance">
          <div>
            <span>
              {symbol}
              {formattedCurrent}
            </span>
            <span>present</span>
          </div>
          <div>
            <span>
              {symbol}
              {numberToCommaString(current - available)}
            </span>
            <span>pending</span>
          </div>
        </div>
      );
    }
  } else {
    return (
      <div className="Balance">
        <div>
          <span>
            {symbol}
            {numberToCommaString(available || current || 0)}
          </span>
          <span>available</span>
        </div>
      </div>
    );
  }
};

export default Balance;
