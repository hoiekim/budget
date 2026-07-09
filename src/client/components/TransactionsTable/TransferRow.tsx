import { MouseEventHandler } from "react";
import { numberToCommaString, currencyCodeToSymbol, LocalDate } from "common";
import { useAppContext, PATH } from "client";
import { RightArrowIcon } from "client/components";
import type { JSONTransaction } from "common";

interface Props {
  /** Both transactions in the confirmed pair, in server order. */
  transactions: JSONTransaction[];
}

/**
 * Bundled single-row presentation of a confirmed transfer pair (#354
 * phase 3). The two paired transactions are folded into one row that
 * shows the date, both accounts (from → to), a `TransferArrowIcon` in
 * place of the +/− amount sign, and a "Transfer" chip where the
 * budget/category selects would normally sit.
 *
 * The first transaction in the pair is rendered as the "outgoing" side
 * (negative amount → money leaving) and the second is the "incoming"
 * side. Plaid signs both with the same sign relative to each account,
 * so we pick the side with the negative `amount` as the source to keep
 * the visual stable regardless of pair ordering.
 */
const TransferRow = ({ transactions }: Props) => {
  const { data, router } = useAppContext();
  const { accounts } = data;
  const { go } = router;

  // The outgoing side is the one whose amount is positive (Plaid: outflow
  // = positive, inflow = negative). Fall back to the first if signs are
  // equal so the layout never disappears.
  const outgoing = transactions.find((t) => t.amount > 0) ?? transactions[0];
  const incoming =
    transactions.find((t) => t.transaction_id !== outgoing.transaction_id) ?? transactions[1];

  const fromAccount = accounts.get(outgoing.account_id);
  const toAccount = accounts.get(incoming.account_id);

  const displayAmount = Math.abs(outgoing.amount);
  const isoCurrency = outgoing.iso_currency_code || incoming.iso_currency_code || "";

  // Detail-page navigation lands on the outgoing side — that's the row
  // the user would have clicked on the un-bundled view. (The detail
  // page itself surfaces the pair as a unit.)
  const onClickInfo: MouseEventHandler<HTMLDivElement> = () => {
    const params = new URLSearchParams(router.params);
    params.set("transaction_id", outgoing.transaction_id);
    go(PATH.TRANSACTION_DETAIL, { params });
  };

  const date = outgoing.authorized_date || outgoing.date;

  return (
    <div className="TransactionRow TransferRow">
      <div className="transactionInfo" onClick={onClickInfo}>
        <div className="authorized_date bigText">
          {new LocalDate(date).toLocaleString("en-US", {
            month: "numeric",
            day: "numeric",
          })}
        </div>
        <div className="merchant_name">
          <div className="bigText">Transfer</div>
          <div className="smallText">
            {fromAccount?.custom_name || fromAccount?.name}
            &nbsp;
            <RightArrowIcon size={8} />
            &nbsp;
            {toAccount?.custom_name || toAccount?.name}
          </div>
        </div>
        <div className="amount transferAmount">
          {currencyCodeToSymbol(isoCurrency)}&nbsp;
          {numberToCommaString(displayAmount)}
        </div>
      </div>
    </div>
  );
};

export default TransferRow;
