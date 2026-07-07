import { useAppContext, PATH } from "client";
import {
  InvestmentTransactionProperties,
  Page,
  TransactionProperties,
  TransferProperties,
} from "client/components";

import "./index.css";

export type TransactionDetailPageParams = {
  transaction_id?: string;
  investment_transaction_id?: string;
};

export const TransactionDetailPage = () => {
  const { data, router } = useAppContext();
  const { transactions, investmentTransactions, transfers } = data;

  const { path, params, transition } = router;
  const paramsToRead =
    path === PATH.TRANSACTION_DETAIL ? params : transition.incomingParams;
  const transactionId = paramsToRead.get("transaction_id") || "";
  const investmentTransactionId = paramsToRead.get("investment_transaction_id") || "";

  const investmentTransaction = investmentTransactionId
    ? investmentTransactions.get(investmentTransactionId)
    : undefined;
  if (investmentTransaction) {
    return (
      <Page className="TransactionDetailPage">
        <InvestmentTransactionProperties investmentTransaction={investmentTransaction} />
      </Page>
    );
  }

  const transaction = transactionId ? transactions.get(transactionId) : undefined;
  if (!transaction) return <></>;

  // Confirmed-transfer rows surface the same kebab → detail route as a
  // regular transaction, but the page should treat the pair as the
  // entity, not one side of it (Hoie 2026-06-17). Branch on whether the
  // clicked transaction is part of a confirmed pair and render the
  // dedicated `TransferProperties` view if so.
  const lookedUp = transfers.byTransactionId.get(transaction.transaction_id);
  const confirmedTransfer = lookedUp?.status === "confirmed" ? lookedUp : undefined;

  return (
    <Page className="TransactionDetailPage">
      {confirmedTransfer ? (
        <TransferProperties transfer={confirmedTransfer} />
      ) : (
        <TransactionProperties transaction={transaction} />
      )}
    </Page>
  );
};
