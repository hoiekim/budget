import { useEffect, useState } from "react";
import { Transaction } from "common";
import { useAppContext, PATH } from "client";
import { TransactionProperties, ActionButtons } from "client/components";

import "./index.css";

export type TransactionDetailPageParams = {
  id?: string;
};

const TransactionDetailPage = () => {
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

  const finishEditing = () => router.back();

  const onComplete = async () => {
    try {
    } catch (error: any) {
      console.error(error);
    }

    router.back();
  };

  return (
    <div className="TransactionDetailPage">
      <TransactionProperties transaction={transaction} />
      {/* <ActionButtons onComplete={onComplete} onCancel={finishEditing} /> */}
    </div>
  );
};

export default TransactionDetailPage;
