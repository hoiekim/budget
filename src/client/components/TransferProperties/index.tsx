import { currencyCodeToSymbol, LocalDate, numberToCommaString } from "common";
import type { JSONTransaction } from "common";
import { useAppContext, type ConfirmedTransfer } from "client";
import { InstitutionSpan, TransferArrowIcon } from "client/components";
import "./index.css";

interface Props {
  /** Both transactions in the confirmed pair, in server order. */
  transfer: ConfirmedTransfer;
}

/**
 * Detail page for a confirmed transfer PAIR rather than for either
 * single transaction inside it. Hoie 2026-06-17: the kebab on a transfer
 * row should land here regardless of which side the user clicked from,
 * so the page can't be biased toward the "outgoing" side — both sides
 * are surfaced as equal first-class halves of the transfer.
 *
 * Layout mirrors the other `*Properties` panels: `propertyLabel`
 * section headers, `row keyValue` rows inside, so this component reads
 * the same as TransactionProperties / ConnectionProperties / etc.
 */
export const TransferProperties = ({ transfer }: Props) => {
  const { data, transfers } = useAppContext();
  const { accounts } = data;

  // Sides are anchored to the SIGN of the amount, not the array index,
  // so the visual stays stable regardless of how the server orders the
  // pair. Plaid: positive amount = outflow (money leaving), negative =
  // inflow.
  const [a, b] = transfer.transactions;
  const outgoing: JSONTransaction = a.amount > 0 ? a : b;
  const incoming: JSONTransaction = outgoing.transaction_id === a.transaction_id ? b : a;

  const fromAccount = accounts.get(outgoing.account_id);
  const toAccount = accounts.get(incoming.account_id);

  const isoCurrency = outgoing.iso_currency_code || incoming.iso_currency_code || "";
  const currencySymbol = currencyCodeToSymbol(isoCurrency);
  const displayAmount = Math.abs(outgoing.amount);
  const date = outgoing.authorized_date || outgoing.date;

  const onClickUnpair = async () => {
    await transfers.unpair(transfer.pair_id);
  };

  // Per-side block reusable for both halves of the pair. Each side's
  // own date / amount / memo is rendered — Plaid posts the two halves
  // independently so they can carry different timestamps.
  const renderSide = (label: string, tx: JSONTransaction, account: ReturnType<typeof accounts.get>) => {
    const txDate = tx.authorized_date || tx.date;
    const txLocations = [tx.location?.city, tx.location?.region, tx.location?.country].filter((e) => e);
    return (
      <>
        <div className="propertyLabel">{label}</div>
        <div className="property">
          <div className="row keyValue">
            <span className="propertyName">Account</span>
            <span>{account?.custom_name || account?.name || tx.account_id}</span>
          </div>
          <div className="row keyValue">
            <span className="propertyName">Institution</span>
            {account ? <InstitutionSpan institution_id={account.institution_id} /> : <span />}
          </div>
          <div className="row keyValue">
            <span className="propertyName">Date</span>
            <span>
              {new LocalDate(txDate).toLocaleString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
          <div className="row keyValue">
            <span className="propertyName">Merchant&nbsp;Name</span>
            <span>{tx.merchant_name}</span>
          </div>
          <div className="row keyValue">
            <span className="propertyName">Name</span>
            <span>{tx.name}</span>
          </div>
          <div className="row keyValue">
            <span className="propertyName">Amount</span>
            <span>
              {currencyCodeToSymbol(tx.iso_currency_code || "")}&nbsp;
              {numberToCommaString(Math.abs(tx.amount))}
            </span>
          </div>
          {txLocations.length > 0 && (
            <div className="row keyValue">
              <span className="propertyName">Location</span>
              <span>{txLocations.join(", ")}</span>
            </div>
          )}
          {tx.label?.memo && (
            <div className="row keyValue">
              <span className="propertyName">Memo</span>
              <span>{tx.label.memo}</span>
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <div className="TransferProperties Properties">
      <div className="propertyLabel">Transfer&nbsp;Details</div>
      <div className="property">
        <div className="row keyValue">
          <span className="propertyName">Type</span>
          <span className="transferChip transferChipConfirmed">
            <TransferArrowIcon size={12} />
            &nbsp;Transfer
          </span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Date</span>
          <span>
            {new LocalDate(date).toLocaleString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </div>
        <div className="row keyValue">
          <span className="propertyName">Amount</span>
          <span className="transferAmountInline">
            <TransferArrowIcon size={12} />
            &nbsp;{currencySymbol}&nbsp;
            {numberToCommaString(displayAmount)}
          </span>
        </div>
      </div>
      {renderSide("From", outgoing, fromAccount)}
      {renderSide("To", incoming, toAccount)}
      <div className="propertyLabel">Actions</div>
      <div className="property">
        <div className="row button">
          <button className="unpairButton" onClick={onClickUnpair}>
            Mark&nbsp;as&nbsp;Non-Transfer
          </button>
        </div>
      </div>
    </div>
  );
};
