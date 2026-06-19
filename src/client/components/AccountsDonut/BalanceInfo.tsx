import { DonutData, getDisplayBalance, useAppContext } from "client";
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
  const { calculations, viewDate, data } = useAppContext();
  const { balanceData } = calculations;
  const { accounts } = data;

  const today = new Date();
  const viewDateSpan = Math.max(-viewDate.getSpanFrom(today), 0);
  const previousDate = viewDate.clone().previous().getEndDate();

  // Match the headline total's loading-aware fallback (#510): while history is
  // still streaming, missing previous-period balances fall back to the live
  // balance rather than 0, so the "from last <period>" delta doesn't spike.
  const previousAmount = donutData.reduce((a, { id }) => {
    const account = accounts.get(id);
    if (!account) return a;
    return a + getDisplayBalance(balanceData, account, previousDate, today, data.status.isLoading);
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
