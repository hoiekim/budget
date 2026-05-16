import { DonutData, useAppContext } from "client";
import { Changes } from "client/components";

interface Props {
  currencySymbol: string;
  donutData: DonutData[];
  totalCredit: number;
  numberOfCredits: number;
  isShrunk: boolean;
}

export const BalanceInfo = ({
  currencySymbol,
  donutData,
  totalCredit,
  numberOfCredits,
  isShrunk,
}: Props) => {
  const { calculations, viewDate } = useAppContext();
  const { balanceData } = calculations;

  const viewDateSpan = Math.max(-viewDate.getSpanFrom(new Date()), 0);
  const previousDate = viewDate.clone().previous().getEndDate();

  // Mirror per-row gate (AccountsTable/Balance.tsx: `!!previousAmount`): skip accounts
  // with no usable previous-period entry on BOTH sides — otherwise the donut counts
  // those accounts' current balance while the per-row widgets don't, overstating change.
  let comparableCurrent = 0;
  let comparablePrevious = 0;
  for (const { id, value } of donutData) {
    const balanceHistory = balanceData.get(id);
    if (!balanceHistory) continue;
    const prev = balanceHistory.get(previousDate) || 0;
    if (!prev) continue;
    comparableCurrent += value;
    comparablePrevious += prev;
  }

  return (
    <div className="BalanceInfo">
      <Changes
        currentAmount={comparableCurrent}
        previousAmount={comparablePrevious}
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
          <div className="credit label">in&nbsp;{numberOfCredits}&nbsp;Credits</div>
        </>
      )}
    </div>
  );
};
