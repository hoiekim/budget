import { Account, currencyCodeToSymbol, numberToCommaString } from "common";
import { AccountSubtype, AccountType } from "plaid";

interface Props {
  balances: Account["balances"];
  type: Account["type"];
  subtype: Account["subtype"];
}

export const Balance = ({ balances, type, subtype }: Props) => {
  const { available, current, iso_currency_code, unofficial_currency_code } = balances;

  const symbol = currencyCodeToSymbol(iso_currency_code || unofficial_currency_code || "USD");
  const formattedAvailable = numberToCommaString(available as number);
  const formattedCurrent = numberToCommaString(current as number);

  if (type === AccountType.Credit) {
    return (
      <div className="Balance">
        <div>
          <span>
            {symbol}
            {formattedCurrent}
          </span>
          <span>spent</span>
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
  } else if (type === AccountType.Investment) {
    return (
      <div className="Balance">
        <div>
          <span>
            {symbol}
            {formattedCurrent}
          </span>
          <span>invested</span>
        </div>
        {subtype !== AccountSubtype.CryptoExchange && (
          <div>
            <span>
              {symbol}
              {formattedAvailable}
            </span>
            <span>in cash</span>
          </div>
        )}
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
