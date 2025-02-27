import { useEffect, useState } from "react";
import { Transaction } from "common";
import { useAppContext, PATH } from "client";
import { TransactionProperties } from "client/components";

import "./index.css";

export type TransactionDetailPageParams = {
  id?: string;
};

export const TransactionDetailPage = () => {
  const { data, router } = useAppContext();
  const { transactions } = data;

  const { path, params, transition } = router;
  let id: string;
  if (path === PATH.BUDGET_CONFIG) id = params.get("id") || "";
  else id = transition.incomingParams.get("id") || "";

  const defaultTransaction = transactions.get(id);
  const [transaction, setTransaction] = useState<Transaction | undefined>(defaultTransaction);

  useEffect(() => {
    const newTransaction = transactions.get(id);
    setTransaction(
      (oldTransaction) => (newTransaction && new Transaction(newTransaction)) || oldTransaction
    );
  }, [id, transactions]);

  if (!transaction) return <></>;

  return (
    <div className="TransactionDetailPage">
      <TransactionProperties transaction={transaction} />
    </div>
  );
};
