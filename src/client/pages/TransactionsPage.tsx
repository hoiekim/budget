import { useMemo } from "react";
import { IsDate, useAppContext } from "client";
import { TransactionsTable } from "client/components";
import { Transaction } from "server";

const TransactionsPage = () => {
  const { transactions, accounts, selectedInterval, viewDate } = useAppContext();

  const { allTransactions, unsortedTransactions } = useMemo(() => {
    const allTransactions: Transaction[] = [];
    const unsortedTransactions: Transaction[] = [];
    const isViewDate = new IsDate(viewDate);
    transactions.forEach((e) => {
      const hidden = accounts.get(e.account_id)?.hide;
      const transactionDate = new Date(e.authorized_date || e.date);
      const within = isViewDate.within(selectedInterval).from(transactionDate);
      if (!hidden && within) {
        allTransactions.push(e);
        if (!e.label.category_id) unsortedTransactions.push(e);
      }
    });
    return { allTransactions, unsortedTransactions };
  }, [transactions, accounts, selectedInterval, viewDate]);

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
