import { useMemo } from "react";
import { useAppContext } from "client";
import { TransactionsTable } from "client/components";
import { Transaction } from "server";
import "./index.css";

const TransactionsPage = () => {
  const { transactions, accounts, viewDate } = useAppContext();

  const { allTransactions, unsortedTransactions } = useMemo(() => {
    const allTransactions: Transaction[] = [];
    const unsortedTransactions: Transaction[] = [];
    const viewDateClone = viewDate.clone();
    transactions.forEach((e) => {
      const hidden = accounts.get(e.account_id)?.hide;
      const transactionDate = new Date(e.authorized_date || e.date);
      const within = viewDateClone.has(transactionDate);
      if (!hidden && within) {
        allTransactions.push(e);
        if (!e.label.category_id) unsortedTransactions.push(e);
      }
    });
    return { allTransactions, unsortedTransactions };
  }, [transactions, accounts, viewDate]);

  return (
    <div className="TransactionsPage">
      <h2>Unsorted Transactions</h2>
      <TransactionsTable customKey="unsorted" transactionsArray={unsortedTransactions} />
      <h2>All Transactions</h2>
      <TransactionsTable customKey="all" transactionsArray={allTransactions} />
    </div>
  );
};

export default TransactionsPage;
