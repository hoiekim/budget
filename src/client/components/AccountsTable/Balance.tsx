import { Account, currencyCodeToSymbol, numberToCommaString } from "common";
import { AccountSubtype, AccountType } from "plaid";

interface Props {
  balances: Account["balances"];
  type: Account["type"];
  subtype: Account["subtype"];
  previousAmount?: number;
}

export const Balance = ({ balances, type, subtype, previousAmount }: Props) => {
  const { available, current, iso_currency_code, unofficial_currency_code } = balances;

  const symbol = currencyCodeToSymbol(iso_currency_code || unofficial_currency_code || "USD");
  const availableString = numberToCommaString(available!);
  const currentString = numberToCommaString(current!);
  const combined = numberToCommaString(available! + current!);

  const getChanges = (currentAmount: number) => {
    if (previousAmount === undefined) return undefined;

    const changes = currentAmount - previousAmount;

    if (changes === 0) return <div className="neutral">-</div>;

    const changesString = "$" + numberToCommaString(Math.abs(changes));

    if (changes > 0) return <div className="colored positive">+{changesString}</div>;
    return <div className="colored negative">-{changesString}</div>;
  };

  if (type === AccountType.Credit) {
    return (
      <div className="Balance credit">
        <div>
          <span>
            {symbol}
            {currentString}
          </span>
          <span>spent</span>
        </div>
        <div>
          <span>
            {symbol}
            {availableString}
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
          {currentString}
        </div>
        {getChanges(current!)}
      </div>
    );
  } else if (type === AccountType.Investment) {
    return (
      <div className="Balance">
        <div>
          {symbol}
          {combined}
        </div>
        {getChanges(available! + current!)}
      </div>
    );
  } else {
    return (
      <div className="Balance">
        <div>
          {symbol}
          {currentString}
        </div>
        {getChanges(current!)}
      </div>
    );
  }
};

export default Balance;
