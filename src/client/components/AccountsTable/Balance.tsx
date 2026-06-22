import { AccountSubtype, AccountType } from "plaid";
import { currencyCodeToSymbol, numberToCommaString } from "common";
import { Account, getDisplayBalance, useAppContext } from "client";

interface BalanceProps {
  account: Account;
}

export const Balance = ({ account }: BalanceProps) => {
  const { viewDate, calculations, data } = useAppContext();
  const { balanceData } = calculations;
  const { type, subtype, balances } = account;
  const { available, current, iso_currency_code, unofficial_currency_code } = balances;

  const symbol = currencyCodeToSymbol(iso_currency_code || unofficial_currency_code || "USD");
  const currentString = numberToCommaString(current!);

  const today = new Date();
  const viewDateDate = viewDate.getEndDate();
  const previousDate = viewDate.clone().previous().getEndDate();
  // Fall back to the live balance for future dates, and for past dates while
  // the cold-load history is still streaming in — flashing $0 there reports a
  // bogus net-worth collapse (#510). Once loaded, missing past data → 0 (#428).
  const isLoading = data.status.isLoading;
  const dynamicAmount = getDisplayBalance(balanceData, account, viewDateDate, today, isLoading);
  const previousAmount = getDisplayBalance(balanceData, account, previousDate, today, isLoading);

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
  }

  // Show the per-row Changes widget whenever either side of the
  // comparison has value — covers regular accounts (prev>0 AND
  // current>0), new accounts (prev=0, current>0 → "+$current"), and
  // closed accounts (prev>0, current=0 → "-$prev"). Closes #357: the
  // donut's `BalanceInfo` headline change already counts new-account
  // currents on the current side; gating the row widget on
  // `!!previousAmount` was hiding the matching per-row entry, which is
  // what made the donut headline appear to disagree with the table.
  // Now the table sums to the same number the donut shows.
  const shouldShowChanges = !!previousAmount || !!dynamicAmount;
  const changesProps = {
    // Use dynamicAmount directly — it is always a number (line 26's `?? fallback`
    // already resolved it). The old `|| current!` substituted the live balance
    // whenever dynamicAmount was 0, which is wrong: $0 is the correct balance for
    // a zero-balance month (closed account, liquidated position), and the row
    // itself renders $0, so the Changes delta must compare against 0, not current.
    currentAmount: dynamicAmount,
    previousAmount,
  };

  if (subtype === AccountSubtype.CryptoExchange || type === AccountType.Investment) {
    return (
      <div className="Balance">
        <div>
          {symbol}
          {numberToCommaString(dynamicAmount)}
        </div>
        {shouldShowChanges && <Changes {...changesProps} />}
      </div>
    );
  }
  return (
    <div className="Balance">
      <div>
        {symbol}
        {numberToCommaString(dynamicAmount)}
      </div>
      {shouldShowChanges && <Changes {...changesProps} />}
    </div>
  );
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
