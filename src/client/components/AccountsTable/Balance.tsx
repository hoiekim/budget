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
  const formattedAvailable = numberToCommaString(available!);
  const formattedCurrent = numberToCommaString(current!);
  const formattedCombined = numberToCommaString(available! + current!);

  if (type === AccountType.Credit) {
    return (
      <div className="Balance credit">
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
  } else if (subtype === AccountSubtype.CryptoExchange) {
    return (
      <div className="Balance">
        <div>
          {symbol}
          {formattedCurrent}
        </div>
      </div>
    );
  } else if (type === AccountType.Investment) {
    return (
      <div className="Balance">
        <div>
          {symbol}
          {formattedCombined}
        </div>
      </div>
    );
  } else {
    return (
      <div className="Balance">
        <div>
          {symbol}
          {formattedCurrent}
        </div>
      </div>
    );
  }
};

export default Balance;
