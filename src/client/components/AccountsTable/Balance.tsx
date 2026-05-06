import { AccountSubtype, AccountType } from "plaid";
import { currencyCodeToSymbol, numberToCommaString } from "common";
import { Account, getAccountBalance, useAppContext } from "client";

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

  const today = new Date();
  const viewDateDate = viewDate.getEndDate();
  const previousDate = viewDate.clone().previous().getEndDate();
  // For future dates (e.g. year-end of the current year), fall back to the
  // current balance rather than 0 so the row shows a meaningful value.
  // For past dates with no history, show 0 (data was never recorded).
  const fallback = viewDateDate > today ? getAccountBalance(account) : 0;
  const dynamicAmount = balanceHistory.get(viewDateDate) ?? fallback;
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
          {dynamicAmount ? numberToCommaString(dynamicAmount) : currentString}
        </div>
        {!!previousAmount && (
          <Changes currentAmount={dynamicAmount || current!} previousAmount={previousAmount} />
        )}
      </div>
    );
  } else if (type === AccountType.Investment) {
    return (
      <div className="Balance">
        <div>
          {symbol}
          {dynamicAmount ? numberToCommaString(dynamicAmount) : currentString}
        </div>
        {!!previousAmount && (
          <Changes currentAmount={dynamicAmount || current!} previousAmount={previousAmount} />
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
        {!!previousAmount && (
          <Changes currentAmount={dynamicAmount || current!} previousAmount={previousAmount} />
        )}
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
