import { useAppContext, PATH } from "client";
import { TransactionProperties, TransferProperties } from "client/components";

import "./index.css";

export type TransactionDetailPageParams = {
  transaction_id?: string;
};

export const TransactionDetailPage = () => {
  const { data, router } = useAppContext();
  const { transactions, transfers } = data;

  const { path, params, transition } = router;
  let id: string;
  if (path === PATH.TRANSACTION_DETAIL) id = params.get("transaction_id") || "";
  else id = transition.incomingParams.get("transaction_id") || "";

  const transaction = transactions.get(id);

  if (!transaction) return <></>;

  // Confirmed-transfer rows surface the same kebab → detail route as a
  // regular transaction, but the page should treat the pair as the
  // entity, not one side of it (Hoie 2026-06-17). Branch on whether the
  // clicked transaction is part of a confirmed pair and render the
  // dedicated `TransferProperties` view if so.
  const lookedUp = transfers.getByTransactionId(transaction.transaction_id);
  const confirmedTransfer = lookedUp?.status === "confirmed" ? lookedUp : undefined;

  return (
    <div className="TransactionDetailPage">
      {confirmedTransfer ? (
        <TransferProperties transfer={confirmedTransfer} />
      ) : (
        <TransactionProperties transaction={transaction} />
      )}
    </div>
  );
};
