import { DonutData, useAppContext } from "client";
import { Changes } from "client/components";

interface Props {
  balanceTotal: number;
  currencySymbol: string;
  donutData: DonutData[];
  isShrunk: boolean;
}

export const BalanceInfo = ({ balanceTotal, currencySymbol, donutData, isShrunk }: Props) => {
  const { data, calculations, viewDate } = useAppContext();
  const { accounts } = data;
  const { balanceData } = calculations;

  const viewDateSpan = Math.max(-viewDate.getSpanFrom(new Date()), 0);
  const previousDate = viewDate.clone().previous().getEndDate();

  const previousAmount = donutData.reduce((a, { id }) => {
    const balanceHistory = balanceData.get(id);
    if (!balanceHistory) return a;
    return a + (balanceHistory.get(previousDate) || 0);
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
