import { DonutData, useAppContext } from "client";
import { Changes } from "client/components";

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

  let totalCredit = 0;
  let numberOfOthers = 0;

  accounts.forEach(({ account_id, balances }) => {
    if (!donutData.find(({ id }) => id === account_id)) {
      totalCredit += balances.current || 0;
      numberOfOthers++;
    }
  });

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
          <Changes
            currentAmount={0}
            previousAmount={!viewDateSpan ? totalCredit : 0}
            currencySymbol={currencySymbol}
          />
          <div className="credit label">outstanding</div>
          <div className="credit label">in&nbsp;{numberOfOthers}&nbsp;Credits</div>
        </>
      )}
    </div>
  );
};
