import { DonutData, useAppContext } from "client";
import { Changes } from "client/components";
import { numberToCommaString } from "common";

interface Props {
  balanceTotal: number;
  currencySymbol: string;
  donutData: DonutData[];
  isShrunk: boolean;
}

export const BalanceInfo = ({ balanceTotal, currencySymbol, donutData, isShrunk }: Props) => {
  const { data, viewDate } = useAppContext();
  const { accounts } = data;

  const viewDateSpan = Math.max(-viewDate.getSpanFrom(new Date()), 0);

  const previousAmount = donutData.reduce((a, { id }) => {
    const account = accounts.get(id);
    if (!account) return a;
    return a + (account.balanceHistory?.[viewDateSpan + 1] || 0);
  }, 0);

  let totalAvailableInOthers = 0;
  let numberOfOthers = 0;

  accounts.forEach(({ account_id, balances }) => {
    if (!donutData.find(({ id }) => id === account_id)) {
      totalAvailableInOthers += balances.available || 0;
      numberOfOthers++;
    }
  });

  const creditAvailable = !viewDateSpan
    ? currencySymbol + numberToCommaString(totalAvailableInOthers)
    : "-";

  return (
    <div className="BalanceInfo">
      <Changes
        currentAmount={balanceTotal}
        previousAmount={previousAmount}
        currencySymbol={currencySymbol}
      />
      <div className="label">from&nbsp;last&nbsp;{viewDate.getInterval()}</div>
      {!isShrunk && (
        <>
          <div className="label">in&nbsp;{donutData.length}&nbsp;Accounts</div>
          <br />
          <div className="neutral">{creditAvailable}</div>
          <div className="label">available</div>
          <div className="label">in&nbsp;{numberOfOthers}&nbsp;Credits</div>
        </>
      )}
    </div>
  );
};
