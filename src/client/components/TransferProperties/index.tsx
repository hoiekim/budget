import { currencyCodeToSymbol, LocalDate, numberToCommaString } from "common";
import type { JSONTransaction } from "common";
import type { TransferPair } from "server";
import { useAppContext, useTransfers } from "client";
import {
  InstitutionSpan,
  KeyValue,
  Properties,
  Property,
  PropertyLabel,
  Row,
  TransferArrowIcon,
} from "client/components";
import "./index.css";

interface Props {
  /** Both transactions in the confirmed pair, in server order. */
  transfer: TransferPair;
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
  const { data } = useAppContext();
  const transferActions = useTransfers();
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
    await transferActions.unpair(transfer.pair_id);
  };

  // Per-side block reusable for both halves of the pair. Each side's
  // own date / amount / memo is rendered — Plaid posts the two halves
  // independently so they can carry different timestamps.
  const renderSide = (
    label: string,
    tx: JSONTransaction,
    account: ReturnType<typeof accounts.get>,
  ) => {
    const txDate = tx.authorized_date || tx.date;
    const txLocations = [tx.location?.city, tx.location?.region, tx.location?.country].filter(
      (e) => e,
    );
    return (
      <>
        <PropertyLabel>{label}</PropertyLabel>
        <Property>
          <KeyValue name="Account">
            <span>{account?.custom_name || account?.name || tx.account_id}</span>
          </KeyValue>
          <KeyValue name="Institution">
            {account ? <InstitutionSpan institution_id={account.institution_id} /> : <span />}
          </KeyValue>
          <KeyValue name="Date">
            <span>
              {new LocalDate(txDate).toLocaleString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </KeyValue>
          <KeyValue name="Merchant&nbsp;Name">
            <span>{tx.merchant_name}</span>
          </KeyValue>
          <KeyValue name="Name">
            <span>{tx.name}</span>
          </KeyValue>
          {txLocations.length > 0 && (
            <KeyValue name="Location">
              <span>{txLocations.join(", ")}</span>
            </KeyValue>
          )}
          {tx.label?.memo && (
            <KeyValue name="Memo">
              <span>{tx.label.memo}</span>
            </KeyValue>
          )}
        </Property>
      </>
    );
  };

  return (
    <Properties className="TransferProperties">
      <PropertyLabel>Transfer&nbsp;Details</PropertyLabel>
      <Property>
        <KeyValue name="Type">
          <span className="transferChip transferChipConfirmed">
            <TransferArrowIcon size={12} />
            &nbsp;Transfer
          </span>
        </KeyValue>
        <KeyValue name="Date">
          <span>
            {new LocalDate(date).toLocaleString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </KeyValue>
        <KeyValue name="Amount">
          <span className="transferAmountInline">
            <TransferArrowIcon size={12} />
            &nbsp;{currencySymbol}&nbsp;
            {numberToCommaString(displayAmount)}
          </span>
        </KeyValue>
      </Property>
      {renderSide("From", outgoing, fromAccount)}
      {renderSide("To", incoming, toAccount)}
      <PropertyLabel>Actions</PropertyLabel>
      <Property>
        <Row className="button">
          <button className="unpairButton" onClick={onClickUnpair}>
            Mark&nbsp;as&nbsp;Non-Transfer
          </button>
        </Row>
      </Property>
    </Properties>
  );
};
