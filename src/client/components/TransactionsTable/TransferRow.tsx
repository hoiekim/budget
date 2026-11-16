import { useAppContext, PATH } from "client";
import { RightArrowIcon, TransactionRowInfo } from "client/components";
import type { JSONTransaction } from "common";
import { getTransactionTitle } from "./transactionTitle";

interface Props {
  /** Both transactions in the confirmed pair, in server order. */
  transactions: JSONTransaction[];
}

/**
 * Bundled single-row presentation of a confirmed transfer pair. The two paired
 * transactions are folded into one row showing the date, both accounts
 * (from → to), the pair's absolute amount (no +/− sign since the money
 * doesn't leave the household), and the outgoing side's name — or the
 * incoming side's when the outgoing one has none — tagged "Transfer".
 * The side whose `amount` is positive (Plaid outflow) is the "outgoing"
 * side; falls back to the first if signs are equal.
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
  const onClickInfo = () => {
    const params = new URLSearchParams(router.params);
    params.set("transaction_id", outgoing.transaction_id);
    go(PATH.TRANSACTION_DETAIL, { params });
  };

  const date = outgoing.authorized_date || outgoing.date;

  const titleOf = (t: JSONTransaction | undefined) =>
    t ? getTransactionTitle(t.label?.memo, t.merchant_name, t.name) : "";
  const title = titleOf(outgoing) || titleOf(incoming);

  return (
    <div className="TransactionRow TransferRow">
      <TransactionRowInfo
        date={date}
        amount={displayAmount}
        isoCurrency={isoCurrency}
        amountSign="none"
        amountClassName="transferAmount"
        onClickInfo={onClickInfo}
      >
        <div className="titleLine">
          <div className="bigText">{title}</div>
          <span className="transferChip">Transfer</span>
        </div>
        <div className="smallText">
          {fromAccount?.custom_name || fromAccount?.name}
          &nbsp;
          <RightArrowIcon size={8} />
          &nbsp;
          {toAccount?.custom_name || toAccount?.name}
        </div>
      </TransactionRowInfo>
    </div>
  );
};

export default TransferRow;
