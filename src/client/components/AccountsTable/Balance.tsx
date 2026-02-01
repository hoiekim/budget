import { AccountSubtype, AccountType } from "plaid";
import { currencyCodeToSymbol, numberToCommaString } from "common";
import { Account, useAppContext } from "client";

interface BalanceProps {
  account: Account;
}

export const Balance = ({ account }: BalanceProps) => {
  const { viewDate, calculations } = useAppContext();
  const { balanceData } = calculations;
  const { type, subtype, balances } = account;
  const balanceHistory = balanceData.get(account.id);
  const { available, current, iso_currency_code, unofficial_currency_code } = balances;

  const symbol = currencyCodeToSymbol(iso_currency_code || unofficial_currency_code || "USD");
  const currentString = numberToCommaString(current!);

  const viewDateDate = viewDate.getEndDate();
  const previousDate = viewDate.clone().previous().getEndDate();
  const dynamicAmount = balanceHistory.get(viewDateDate) || 0;
  const previousAmount = balanceHistory.get(previousDate) || 0;

  if (type === AccountType.Credit) {
    const availableString = numberToCommaString(available!);
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
        {!!previousAmount && <Changes currentAmount={current!} previousAmount={previousAmount} />}
      </div>
    );
  } else if (type === AccountType.Investment) {
    const combined = numberToCommaString(available! + current!);
    return (
      <div className="Balance">
        <div>
          {symbol}
          {dynamicAmount ? numberToCommaString(dynamicAmount) : combined}
        </div>
        {!!previousAmount && (
          <Changes currentAmount={available! + current!} previousAmount={previousAmount} />
        )}
      </div>
    );
  } else {
    return (
      <div className="Balance">
        <div>
          {symbol}
          {dynamicAmount ? numberToCommaString(dynamicAmount) : currentString}
        </div>
        {!!previousAmount && <Changes currentAmount={current!} previousAmount={previousAmount} />}
      </div>
    );
  }
};

interface ChangesProps {
  currentAmount: number;
  previousAmount: number;
  currencySymbol?: string;
}

export const Changes = ({ currentAmount, previousAmount, currencySymbol = "$" }: ChangesProps) => {
  const changes = currentAmount - previousAmount;
  if (changes === 0) return <div className="Changes neutral">-</div>;

  const changesString = currencySymbol + numberToCommaString(Math.abs(changes));
  if (changes > 0) return <div className="Changes colored positive">+{changesString}</div>;
  return <div className="Changes colored negative">-{changesString}</div>;
};
