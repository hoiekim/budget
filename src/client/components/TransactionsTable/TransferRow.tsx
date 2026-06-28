import { MouseEventHandler } from "react";
import { numberToCommaString, currencyCodeToSymbol, LocalDate } from "common";
import { useAppContext, PATH } from "client";
import { InstitutionSpan, KebabIcon, TransferArrowIcon } from "client/components";
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
  const outgoing =
    transactions.find((t) => t.amount > 0) ?? transactions[0];
  const incoming = transactions.find((t) => t.transaction_id !== outgoing.transaction_id) ?? transactions[1];

  const fromAccount = accounts.get(outgoing.account_id);
  const toAccount = accounts.get(incoming.account_id);

  const displayAmount = Math.abs(outgoing.amount);
  const isoCurrency = outgoing.iso_currency_code || incoming.iso_currency_code || "";

  // Detail-page navigation lands on the outgoing side — that's the row
  // the user would have clicked on the un-bundled view. (The detail
  // page itself surfaces the pair as a unit.)
  const onClickKebab: MouseEventHandler<HTMLButtonElement> = () => {
    const params = new URLSearchParams(router.params);
    params.set("transaction_id", outgoing.transaction_id);
    go(PATH.TRANSACTION_DETAIL, { params });
  };

  const date = outgoing.authorized_date || outgoing.date;

  return (
    <div className="TransactionRow TransferRow">
      <div className="transactionInfo">
        <div className="authorized_date bigText">
          {new LocalDate(date).toLocaleString("en-US", {
            month: "numeric",
            day: "numeric",
          })}
        </div>
        <div className="merchant_name">
          <div className="bigText">
            {fromAccount?.custom_name || fromAccount?.name}
            <span className="transferPairArrow">
              <TransferArrowIcon size={12} />
            </span>
            {toAccount?.custom_name || toAccount?.name}
          </div>
          <div className="smallText">
            {fromAccount?.institution_id && (
              <InstitutionSpan institution_id={fromAccount.institution_id} />
            )}
          </div>
        </div>
        <div className="amount transferAmount">
          <span className="transferAmountIcon">
            <TransferArrowIcon size={12} />
          </span>
          &nbsp;{currencyCodeToSymbol(isoCurrency)}&nbsp;
          {numberToCommaString(displayAmount)}
        </div>
      </div>
      <div className="budgetCategoryActions">
        <div className="labelControls">
          <span className="transferChip transferChipConfirmed">Transfer</span>
          <span className="transferExclusionNote">
            Excluded from budget totals
          </span>
        </div>
        <div>
          <button className="kebabButton" onClick={onClickKebab}>
            <KebabIcon size={15} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default TransferRow;
