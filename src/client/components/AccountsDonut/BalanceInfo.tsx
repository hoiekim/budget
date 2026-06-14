import { DonutData, useAppContext } from "client";
import { Changes } from "client/components";

interface Props {
  balanceTotal: number;
  currencySymbol: string;
  donutData: DonutData[];
  totalCredit: number;
  numberOfCredits: number;
  isShrunk: boolean;
}

export const BalanceInfo = ({
  balanceTotal,
  currencySymbol,
  donutData,
  totalCredit,
  numberOfCredits,
  isShrunk,
}: Props) => {
  const { calculations, viewDate } = useAppContext();
  const { balanceData } = calculations;

  const previousDate = viewDate.clone().previous().getEndDate();

  const previousAmount = donutData.reduce((a, { id }) => {
    const balanceHistory = balanceData.get(id);
    if (!balanceHistory) return a;
    return a + (balanceHistory.get(previousDate) || 0);
  }, 0);

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
            previousAmount={totalCredit}
            currencySymbol={currencySymbol}
          />
          <div className="credit label">outstanding</div>
          <div className="credit label">in&nbsp;{numberOfCredits}&nbsp;Credits</div>
        </>
      )}
    </div>
  );
};
