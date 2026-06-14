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
    // "spent" is the outstanding balance (balances.current). Honor the viewDate
    // the same way every other account type does via `dynamicAmount`: render the
    // month's historical snapshot for past dates and the live balance for
    // current/future ones. This branch used to ignore the viewDate entirely and
    // always show the live balance, which also made the row contradict the
    // donut's outstanding-credit headline for past months.
    const spentString = numberToCommaString(dynamicAmount);
    // `available` isn't snapshotted historically. For past months derive it from
    // the (roughly constant) credit limit minus the outstanding balance so the
    // two figures stay coherent; keep the live value for current/future months
    // and for SimpleFin accounts, which report no limit.
    const { limit } = balances;
    const availableAmount =
      viewDateDate > today || limit == null ? available! : limit - dynamicAmount;
    const availableString = numberToCommaString(availableAmount);
    return (
      <div className="Balance credit">
        <div>
          <span>
            {symbol}
            {spentString}
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
    currentAmount: dynamicAmount || current!,
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
